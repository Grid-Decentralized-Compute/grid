import { type Abi, type Address, createPublicClient, createWalletClient, http, parseEventLogs, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gridMarketAbi, isSecureEndpoint, parseMetadata } from "@grid/shared";
import type { Config } from "./config";
import { log } from "./log";
import { readState, writeState } from "./state";

/** Everything the node does on-chain, through the host's wallet. */
export class Chain {
  readonly account;
  readonly publicClient;
  readonly walletClient;
  private readonly market;
  /** The write in flight or last sent; the next one waits for it. */
  private sending: Promise<void> = Promise.resolve();

  constructor(private readonly config: Config) {
    this.account = privateKeyToAccount(config.privateKey);
    const transport = http(config.rpcUrl);
    this.publicClient = createPublicClient({ chain: config.chain, transport });
    this.walletClient = createWalletClient({ chain: config.chain, transport, account: this.account });
    this.market = { abi: gridMarketAbi, address: config.market } as const;
  }

  get address() {
    return this.account.address;
  }

  getMachine(id: bigint) {
    return this.publicClient.readContract({ ...this.market, functionName: "getMachine", args: [id] });
  }

  getRental(id: bigint) {
    return this.publicClient.readContract({ ...this.market, functionName: "getRental", args: [id] });
  }

  /** ETH this host can pull out of the market with withdraw(). */
  earnings() {
    return this.publicClient.readContract({ ...this.market, functionName: "balances", args: [this.address] });
  }

  /**
   * Lists this machine once. Later runs reuse the id saved in the state file and
   * push a fresh price/metadata if anything changed (new endpoint, new price).
   */
  async ensureListed(metadata: string, priceWei: bigint, available = true): Promise<bigint> {
    const state = readState(this.config.stateDir);
    if (
      state &&
      state.chainId === this.config.chain.id &&
      state.market.toLowerCase() === this.config.market.toLowerCase() &&
      state.host.toLowerCase() === this.address.toLowerCase()
    ) {
      const id = BigInt(state.machineId);
      // A reset local chain can reuse the same addresses with no machines yet: a revert here means "relist".
      const m = await this.getMachine(id).catch(() => null);
      if (m && m.host.toLowerCase() === this.address.toLowerCase()) {
        if (m.metadata !== metadata || m.pricePerHour !== priceWei || m.available !== available) {
          await this.send({ ...this.market, functionName: "updateMachine", args: [id, priceWei, available, metadata] });
          log(`refreshed listing #${id} (price or metadata changed)`);
        }
        return id;
      }
    }

    const receipt = await this.send({ ...this.market, functionName: "listMachine", args: [priceWei, metadata] });
    const [listed] = parseEventLogs({ abi: gridMarketAbi, eventName: "MachineListed", logs: receipt.logs });
    if (!listed) throw new Error("listMachine succeeded but no MachineListed event was found");
    const id = listed.args.machineId;
    writeState(this.config.stateDir, {
      chainId: this.config.chain.id,
      market: this.config.market,
      host: this.address,
      machineId: id.toString(),
    });
    // A new listing starts open; close it right away when this machine cannot take direct rentals.
    if (!available) await this.setAvailable(id, false);
    return id;
  }

  /**
   * libp2p addresses other hosts published in their listings: where to join the network. The
   * newest listings first, at most 50 addresses, so a burst of old junk listings cannot crowd out
   * live ones (parseMetadata already drops malformed addresses).
   */
  async listedPeerAddrs(): Promise<string[]> {
    const listings = await this.recentListings();
    return listings.flatMap(({ machine }) => parseMetadata(machine.metadata)?.p2p?.addrs ?? []).slice(0, 50);
  }

  /**
   * Relays as their own listings declare them: peer id -> https URL. A node behind a router only
   * trusts a relay that appears here, so a peer cannot just announce itself as one and capture the
   * node's results address.
   */
  async listedRelays(): Promise<Map<string, string>> {
    const relays = new Map<string, string>();
    for (const { machine } of await this.recentListings()) {
      const meta = parseMetadata(machine.metadata);
      const secure = meta?.endpoint.startsWith("https://") || (this.config.allowPrivatePeers && meta && isSecureEndpoint(meta.endpoint));
      if (meta?.p2p?.relay && secure && meta.endpoint.length <= 200) relays.set(meta.p2p.peer, meta.endpoint);
    }
    return relays;
  }

  private async recentListings() {
    const count = await this.publicClient.readContract({ ...this.market, functionName: "machineCount" });
    const offset = count > 200n ? count - 200n : 0n;
    const page = await this.publicClient.readContract({ ...this.market, functionName: "getListings", args: [offset, 200n] });
    return [...page].reverse();
  }

  async setAvailable(id: bigint, available: boolean) {
    await this.updateListing(id, { available });
  }

  /**
   * Changes the price and/or availability of this host's listing and keeps everything else as it is
   * on-chain. Nothing is sent when the listing already shows these values; returns whether a
   * transaction was.
   */
  async updateListing(id: bigint, change: { price?: bigint; available?: boolean }): Promise<boolean> {
    const m = await this.getMachine(id);
    const price = change.price ?? m.pricePerHour;
    const available = change.available ?? m.available;
    if (m.pricePerHour === price && m.available === available) return false;
    await this.send({ ...this.market, functionName: "updateMachine", args: [id, price, available, m.metadata] });
    return true;
  }

  async endRental(id: bigint) {
    await this.send({ ...this.market, functionName: "endRental", args: [id] });
  }

  /**
   * Sends a contract write from the host wallet and waits for it to succeed. The gas estimate gets
   * 25% headroom: several hosts writing to the same contract in one block can each cost a little
   * more than the estimate made a moment earlier. `reserve` adds a fixed amount on top for calls
   * whose cost depends on what other hosts do first (a swarm submit that lands second has to
   * settle every task it touches). Only gas actually used is paid for. Writes go out one at a time:
   * the node sends from several loops (swarm work, the schedule, pricing) and one wallet has one nonce.
   */
  send(call: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }, reserve = 0n) {
    const turn = this.sending.then(() => this.sendNow(call, reserve));
    this.sending = turn.then(() => {}, () => {});
    return turn;
  }

  private async sendNow(call: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }, reserve: bigint) {
    const request = { ...call, account: this.account } as Parameters<Chain["publicClient"]["estimateContractGas"]>[0];
    const gas = await this.publicClient.estimateContractGas(request);
    const headroom = (gas * 5n) / 4n;
    const hash = await this.walletClient.writeContract({
      ...(request as Parameters<Chain["walletClient"]["writeContract"]>[0]),
      gas: headroom > gas + reserve ? headroom : gas + reserve,
    });
    return this.wait(hash);
  }

  private async wait(hash: Hash) {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted on-chain`);
    return receipt;
  }
}
