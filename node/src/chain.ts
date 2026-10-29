import { type Abi, type Address, createPublicClient, createWalletClient, http, parseEventLogs, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gridMarketAbi } from "@grid/shared";
import type { Config } from "./config";
import { log } from "./log";
import { readState, writeState } from "./state";

/** Everything the node does on-chain, through the host's wallet. */
export class Chain {
  readonly account;
  readonly publicClient;
  readonly walletClient;
  private readonly market;

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
  async ensureListed(metadata: string, priceWei: bigint): Promise<bigint> {
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
        if (m.metadata !== metadata || m.pricePerHour !== priceWei || !m.available) {
          await this.send({ ...this.market, functionName: "updateMachine", args: [id, priceWei, true, metadata] });
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
    return id;
  }

  async setAvailable(id: bigint, available: boolean) {
    const m = await this.getMachine(id);
    if (m.available === available) return;
    await this.send({ ...this.market, functionName: "updateMachine", args: [id, m.pricePerHour, available, m.metadata] });
  }

  async endRental(id: bigint) {
    await this.send({ ...this.market, functionName: "endRental", args: [id] });
  }

  /**
   * Sends a contract write from the host wallet and waits for it to succeed. The gas estimate gets
   * 25% headroom: several hosts writing to the same contract in one block can each cost a little
   * more than the estimate made a moment earlier.
   */
  async send(call: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }) {
    const request = { ...call, account: this.account } as Parameters<Chain["publicClient"]["estimateContractGas"]>[0];
    const gas = await this.publicClient.estimateContractGas(request);
    const hash = await this.walletClient.writeContract({
      ...(request as Parameters<Chain["walletClient"]["writeContract"]>[0]),
      gas: (gas * 5n) / 4n,
    });
    return this.wait(hash);
  }

  private async wait(hash: Hash) {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted on-chain`);
    return receipt;
  }
}
