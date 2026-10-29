import {
  type AccessInfo,
  accessMessage,
  chainById,
  costSoFar,
  deployments,
  encodeManifest,
  gpuModel,
  gridMarketAbi,
  isSecureEndpoint,
  MAX_MANIFEST_BYTES,
  type MachineMetadata,
  parseMetadata,
  resultHash,
  resultUrl,
  stakeRegistryAbi,
  SWARM_RUNS,
  type SwarmManifest,
  swarmMarketAbi,
  TaskStatus,
  TRIAL_MAX_DEPOSIT_WEI,
} from "@grid/shared";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  formatEther,
  type Hex,
  http,
  parseEther,
  parseEventLogs,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** A user-facing problem: the message is shown to the agent as is. */
export class GridError extends Error {}

const PAGE = 50n;
const eth = (wei: bigint) => formatEther(wei);

export type Config = {
  chainId: number;
  rpcUrl?: string;
  privateKey?: Hex;
  /** Most ETH a single transaction from this server may carry. */
  maxSpend: bigint;
};

export function configFromEnv(env = process.env): Config {
  const key = env.GRID_AGENT_PRIVATE_KEY?.trim();
  if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("GRID_AGENT_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
  return {
    chainId: Number(env.GRID_CHAIN_ID ?? 46630),
    rpcUrl: env.GRID_RPC_URL || undefined,
    privateKey: key ? (key as Hex) : undefined,
    maxSpend: parseEther(env.GRID_AGENT_MAX_SPEND ?? "0.02"),
  };
}

export type Machine = {
  id: string;
  name: string;
  gpu: string;
  gpuModel: string;
  gpuCount: number;
  vramGb: number;
  cpu: string;
  ramGb: number;
  diskGb: number;
  pricePerHourEth: string;
  pricePerGpuHourEth: string;
  status: "available" | "rented" | "paused" | "offline" | "unreachable" | "swarm-only" | "needs-bond" | "no-details";
  free: boolean;
  host: Address;
  hostBonded: boolean;
  /** Most hours one rental can buy: unbonded hosts are capped at 0.01 ETH per rental. */
  maxHours: number;
  endpoint: string | null;
};

export class Grid {
  readonly chainId: number;
  readonly chainName: string;
  readonly market: Address;
  readonly swarm: Address | null;
  readonly stake: Address;
  readonly account;
  private readonly client;
  private readonly wallet;
  private readonly maxSpend: bigint;

  constructor(config: Config) {
    const chain = chainById(config.chainId);
    if (!chain) throw new Error(`Unknown chain ${config.chainId}. Use 46630 (Robinhood Chain testnet), 4663 or 31337.`);
    const deployment = deployments[config.chainId as keyof typeof deployments] as
      | { GridMarket: Address; StakeRegistry: Address; SwarmMarket?: Address }
      | undefined;
    if (!deployment) throw new GridError(`Grid is not deployed on ${chain.name} (chain ${config.chainId}) yet.`);
    this.chainId = config.chainId;
    this.chainName = chain.name;
    this.market = deployment.GridMarket;
    this.stake = deployment.StakeRegistry;
    this.swarm = deployment.SwarmMarket ?? null;
    this.maxSpend = config.maxSpend;
    const transport = http(config.rpcUrl);
    this.client = createPublicClient({ chain, transport });
    this.account = config.privateKey ? privateKeyToAccount(config.privateKey) : null;
    this.wallet = this.account ? createWalletClient({ account: this.account, chain, transport }) : null;
  }

  // ---------------------------------------------------------------- wallet

  private me() {
    if (!this.account || !this.wallet) {
      throw new GridError("No wallet: set GRID_AGENT_PRIVATE_KEY for this server to rent, post jobs or manage machines.");
    }
    return { account: this.account, wallet: this.wallet };
  }

  private checkSpend(wei: bigint, what: string) {
    if (wei > this.maxSpend) {
      throw new GridError(
        `${what} costs ${eth(wei)} ETH, above this server's limit of ${eth(this.maxSpend)} ETH per transaction (GRID_AGENT_MAX_SPEND).`,
      );
    }
  }

  async walletInfo() {
    const address = this.account?.address ?? null;
    const [balance, marketOwed, swarmOwed] = address
      ? await Promise.all([
          this.client.getBalance({ address }),
          this.client.readContract({ address: this.market, abi: gridMarketAbi, functionName: "balances", args: [address] }),
          this.swarm
            ? this.client.readContract({ address: this.swarm, abi: swarmMarketAbi, functionName: "balances", args: [address] })
            : Promise.resolve(0n),
        ])
      : [0n, 0n, 0n];
    return {
      network: `${this.chainName} (chain ${this.chainId})`,
      contracts: { GridMarket: this.market, SwarmMarket: this.swarm, StakeRegistry: this.stake },
      wallet: address,
      balanceEth: eth(balance),
      withdrawableEth: eth(marketOwed + swarmOwed),
      maxSpendPerTransactionEth: eth(this.maxSpend),
      canTransact: address !== null,
    };
  }

  /** Pulls refunds and earnings owed by both markets into the wallet. */
  async withdraw() {
    const { account, wallet } = this.me();
    const out: { market: string; amountEth: string; tx: Hex }[] = [];
    for (const [name, address, abi] of [
      ["GridMarket", this.market, gridMarketAbi],
      ["SwarmMarket", this.swarm, swarmMarketAbi],
    ] as const) {
      if (!address) continue;
      const owed = (await this.client.readContract({ address, abi, functionName: "balances", args: [account.address] })) as bigint;
      if (owed === 0n) continue;
      const tx = await wallet.writeContract({ address, abi, functionName: "withdraw" });
      await this.confirm(tx);
      out.push({ market: name, amountEth: eth(owed), tx });
    }
    return { withdrawn: out, note: out.length ? undefined : "Nothing was owed." };
  }

  private async confirm(hash: Hex) {
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new GridError(`Transaction ${hash} reverted.`);
    return receipt;
  }

  // ---------------------------------------------------------------- market

  private async bondingOff() {
    const minBond = await this.client.readContract({ address: this.stake, abi: stakeRegistryAbi, functionName: "minBond" });
    return minBond === 0n;
  }

  private async listings() {
    const count = await this.client.readContract({ address: this.market, abi: gridMarketAbi, functionName: "machineCount" });
    const pages = await Promise.all(
      Array.from({ length: Number((count + PAGE - 1n) / PAGE) }, (_, i) =>
        this.client.readContract({ address: this.market, abi: gridMarketAbi, functionName: "getListings", args: [BigInt(i) * PAGE, PAGE] }),
      ),
    );
    return pages.flat();
  }

  /** Every listed machine with its live status; health checks run in parallel, four seconds each at most. */
  async machines(): Promise<Machine[]> {
    const [items, bondingOff] = await Promise.all([this.listings(), this.bondingOff()]);
    return Promise.all(
      items.map(async ({ id, machine, rentable, hostBonded }) => {
        const meta = parseMetadata(machine.metadata);
        const reachable = meta ? await this.healthy(meta.endpoint) : false;
        const status = machineStatus(meta, machine, rentable, reachable);
        const capped = !bondingOff && !hostBonded;
        const maxHours = capped ? Number(TRIAL_MAX_DEPOSIT_WEI / machine.pricePerHour) : 720;
        return describe(id, meta, machine.host, machine.pricePerHour, status, hostBonded, Math.min(720, maxHours));
      }),
    );
  }

  private async healthy(endpoint: string): Promise<boolean | "insecure"> {
    if (!isSecureEndpoint(endpoint)) return "insecure";
    try {
      const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(4000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async rent(machineId: bigint, hours: number) {
    const { account, wallet } = this.me();
    const machine = (await this.machines()).find((m) => m.id === machineId.toString());
    if (!machine) throw new GridError(`There is no machine ${machineId}.`);
    if (!machine.free) throw new GridError(`Machine ${machineId} is not free to rent (status: ${machine.status}).`);
    if (machine.host.toLowerCase() === account.address.toLowerCase()) throw new GridError("That machine is yours.");
    if (hours > machine.maxHours) {
      throw new GridError(`Machine ${machineId} can be rented for at most ${machine.maxHours} hours at a time (its host is in the unbonded trial).`);
    }
    const cost = await this.client.readContract({ address: this.market, abi: gridMarketAbi, functionName: "quote", args: [machineId, BigInt(hours)] });
    this.checkSpend(cost, `Renting machine ${machineId} for ${hours} h`);
    const tx = await wallet.writeContract({ address: this.market, abi: gridMarketAbi, functionName: "rent", args: [machineId, BigInt(hours)], value: cost });
    const receipt = await this.confirm(tx);
    const [rented] = parseEventLogs({ abi: gridMarketAbi, eventName: "Rented", logs: receipt.logs });
    return {
      rentalId: rented.args.rentalId.toString(),
      machine: { id: machine.id, name: machine.name, gpu: machine.gpu, gpuCount: machine.gpuCount },
      hours,
      paidEth: eth(cost),
      tx,
      next: "Call get_access with this rentalId for the SSH login. Unused time is refunded when the rental is ended early.",
    };
  }

  /** Proves to the host's node that this wallet holds the rental, and returns the SSH login. */
  async access(rentalId: bigint): Promise<AccessInfo> {
    const { account } = this.me();
    const view = await this.client.readContract({ address: this.market, abi: gridMarketAbi, functionName: "getRental", args: [rentalId] });
    if (view.renter.toLowerCase() !== account.address.toLowerCase()) throw new GridError(`Rental ${rentalId} belongs to another wallet.`);
    if (view.ended) throw new GridError(`Rental ${rentalId} has ended.`);
    const machine = await this.client.readContract({ address: this.market, abi: gridMarketAbi, functionName: "getMachine", args: [view.machineId] });
    const meta = parseMetadata(machine.metadata);
    if (!meta) throw new GridError("The machine's listing has no node address.");
    if (!isSecureEndpoint(meta.endpoint)) throw new GridError("The machine's node address is not https, so the password cannot be fetched safely.");
    // The node answers 409 while it is still starting the container.
    for (let attempt = 0; attempt < 30; attempt++) {
      const ts = Math.floor(Date.now() / 1000);
      const sig = await account.signMessage({ message: accessMessage(rentalId, ts) });
      const res = await fetch(`${meta.endpoint}/access/${rentalId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ts, sig }),
        signal: AbortSignal.timeout(10_000),
      }).catch((e: Error) => {
        throw new GridError(`The machine's node did not answer: ${e.message}`);
      });
      if (res.ok) return (await res.json()) as AccessInfo;
      if (res.status !== 409) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new GridError(`The node refused access: ${body.error ?? res.statusText}`);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new GridError("The node is still starting the container after 90 seconds; try get_access again shortly.");
  }

  async rentals() {
    const { account } = this.me();
    const list = await this.client.readContract({ address: this.market, abi: gridMarketAbi, functionName: "getRentalsOf", args: [account.address] });
    const now = Math.floor(Date.now() / 1000);
    return list.map(({ id, rental, machine }) => {
      const meta = parseMetadata(machine.metadata);
      const endsAt = Number(rental.startedAt + rental.paidHours * 3600n);
      const spent = costSoFar(rental, now);
      return {
        rentalId: id.toString(),
        machineId: rental.machineId.toString(),
        machine: meta?.name ?? null,
        gpu: meta ? `${meta.gpuCount > 1 ? `${meta.gpuCount}x ` : ""}${meta.gpu}` : null,
        state: rental.ended ? "ended" : now >= endsAt ? "expired, not settled" : "running",
        startedAt: new Date(Number(rental.startedAt) * 1000).toISOString(),
        endsAt: new Date(endsAt * 1000).toISOString(),
        depositEth: eth(rental.deposit),
        costSoFarEth: eth(spent),
        refundIfEndedNowEth: rental.ended ? "0" : eth(rental.deposit - spent),
      };
    });
  }

  async endRental(rentalId: bigint) {
    const { wallet } = this.me();
    const tx = await wallet.writeContract({ address: this.market, abi: gridMarketAbi, functionName: "endRental", args: [rentalId] });
    const receipt = await this.confirm(tx);
    const [ended] = parseEventLogs({ abi: gridMarketAbi, eventName: "RentalEnded", logs: receipt.logs });
    return {
      rentalId: rentalId.toString(),
      paidToHostEth: eth(ended.args.paidToHost),
      refundedEth: eth(ended.args.refunded),
      tx,
      next: "The refund is held by the market; call withdraw to move it to the wallet.",
    };
  }

  // ---------------------------------------------------------------- hosting

  async myMachines() {
    const { account } = this.me();
    const [list, owed] = await Promise.all([
      this.client.readContract({ address: this.market, abi: gridMarketAbi, functionName: "getMachinesOf", args: [account.address] }),
      this.client.readContract({ address: this.market, abi: gridMarketAbi, functionName: "balances", args: [account.address] }),
    ]);
    const machines = await Promise.all(
      list.map(async ({ id, machine, rentable, hostBonded }) => {
        const meta = parseMetadata(machine.metadata);
        const reachable = meta ? await this.healthy(meta.endpoint) : false;
        return {
          ...describe(id, meta, machine.host, machine.pricePerHour, machineStatus(meta, machine, rentable, reachable), hostBonded, 720),
          listed: machine.available,
          activeRentalId: machine.activeRental === 0n ? null : (machine.activeRental - 1n).toString(),
        };
      }),
    );
    return { host: account.address, earningsToWithdrawEth: eth(owed), machines };
  }

  async updateMachine(machineId: bigint, change: { pricePerHourEth?: string; available?: boolean }) {
    const { account, wallet } = this.me();
    const machine = await this.client.readContract({ address: this.market, abi: gridMarketAbi, functionName: "getMachine", args: [machineId] });
    if (machine.host.toLowerCase() !== account.address.toLowerCase()) throw new GridError(`Machine ${machineId} is listed by another wallet.`);
    const price = change.pricePerHourEth !== undefined ? parseEther(change.pricePerHourEth) : machine.pricePerHour;
    if (price <= 0n) throw new GridError("The price must be above zero.");
    const available = change.available ?? machine.available;
    const tx = await wallet.writeContract({
      address: this.market,
      abi: gridMarketAbi,
      functionName: "updateMachine",
      args: [machineId, price, available, machine.metadata],
    });
    await this.confirm(tx);
    return { machineId: machineId.toString(), pricePerHourEth: eth(price), listed: available, tx };
  }

  // ---------------------------------------------------------------- swarm

  private swarmAddress(): Address {
    if (!this.swarm) throw new GridError(`Swarm jobs are not deployed on ${this.chainName}.`);
    return this.swarm;
  }

  async postJob(job: { image: string; command: string; tasks: string[]; gpu: boolean; pricePerRunEth: string; leaseMinutes: number }) {
    const { wallet } = this.me();
    const swarm = this.swarmAddress();
    if (job.tasks.length === 0) throw new GridError("A job needs at least one task.");
    const manifest: SwarmManifest = { v: 1, image: job.image, command: job.command, gpu: job.gpu, tasks: job.tasks };
    const encoded = encodeManifest(manifest);
    if ((encoded.length - 2) / 2 > MAX_MANIFEST_BYTES) throw new GridError(`The job is larger than ${MAX_MANIFEST_BYTES / 1024} KB; split it into several jobs.`);
    const price = parseEther(job.pricePerRunEth);
    if (price <= 0n) throw new GridError("The price per run must be above zero.");
    const deposit = price * BigInt(job.tasks.length) * BigInt(SWARM_RUNS);
    this.checkSpend(deposit, `A job of ${job.tasks.length} tasks`);
    const tx = await wallet.writeContract({
      address: swarm,
      abi: swarmMarketAbi,
      functionName: "postJob",
      args: [price, job.tasks.length, Math.round(job.leaseMinutes * 60), encoded],
      value: deposit,
    });
    const receipt = await this.confirm(tx);
    const [posted] = parseEventLogs({ abi: swarmMarketAbi, eventName: "JobPosted", logs: receipt.logs });
    return {
      jobId: posted.args.jobId.toString(),
      tasks: job.tasks.length,
      depositEth: eth(deposit),
      tx,
      note: `The deposit covers ${SWARM_RUNS} runs per task (two replicas and a tie-break). Unused runs come back when the job is closed.`,
      next: "Poll swarm_job_status; when tasks are done, read them with swarm_results.",
    };
  }

  async jobStatus(jobId: bigint) {
    const swarm = this.swarmAddress();
    const job = await this.client.readContract({ address: swarm, abi: swarmMarketAbi, functionName: "getJob", args: [jobId] });
    const statuses: number[] = [];
    for (let offset = 0; offset < job.taskCount; offset += 500) {
      const page = await this.client.readContract({
        address: swarm,
        abi: swarmMarketAbi,
        functionName: "taskStatuses",
        args: [jobId, offset, Math.min(500, job.taskCount - offset)],
      });
      statuses.push(...page);
    }
    const names = Object.fromEntries(Object.entries(TaskStatus).map(([k, v]) => [v, k.toLowerCase()]));
    const counts: Record<string, number> = {};
    for (const s of statuses) counts[names[s]] = (counts[names[s]] ?? 0) + 1;
    return {
      jobId: jobId.toString(),
      renter: job.renter,
      tasks: job.taskCount,
      resolved: job.resolved,
      done: job.done,
      counts,
      state: job.closed ? "closed" : job.cancelled ? "cancelled" : job.resolved === job.taskCount ? "finished" : "running",
      depositEth: eth(job.deposit),
      paidEth: eth(job.paid),
      pricePerRunEth: eth(job.pricePerRun),
    };
  }

  /**
   * Outputs of finished tasks, fetched from the hosts that produced them and accepted only when
   * their hash matches the one two hosts agreed on, on-chain.
   */
  async results(jobId: bigint, from: number, limit: number) {
    const swarm = this.swarmAddress();
    const job = await this.client.readContract({ address: swarm, abi: swarmMarketAbi, functionName: "getJob", args: [jobId] });
    const end = Math.min(job.taskCount, from + limit);
    const endpoints = new Map<string, string>();
    const out: { task: number; status: string; output?: string; host?: Address }[] = [];
    for (let task = from; task < end; task++) {
      const [runs, state] = await this.client.readContract({ address: swarm, abi: swarmMarketAbi, functionName: "getTask", args: [jobId, task] });
      const agreed = agreedResult(runs.map((r) => r.result));
      if (!agreed) {
        out.push({ task, status: state === 2 ? "failed" : "not done" });
        continue;
      }
      let found: { output: string; host: Address } | null = null;
      for (const run of runs.filter((r) => r.result === agreed)) {
        let endpoint = endpoints.get(run.host);
        if (endpoint === undefined) {
          endpoint = await this.client.readContract({ address: swarm, abi: swarmMarketAbi, functionName: "workerEndpoint", args: [run.host] });
          endpoints.set(run.host, endpoint);
        }
        if (!endpoint || !isSecureEndpoint(endpoint)) continue;
        try {
          const res = await fetch(resultUrl(endpoint, swarm, jobId, task), { signal: AbortSignal.timeout(6000) });
          if (!res.ok) continue;
          const text = await res.text();
          if (resultHash(text) === agreed) {
            found = { output: text, host: run.host };
            break;
          }
        } catch {
          // try the next host that agreed
        }
      }
      out.push(found ? { task, status: "done", ...found } : { task, status: "done, output unreachable" });
    }
    return { jobId: jobId.toString(), from, to: end - 1, tasks: job.taskCount, results: out };
  }

  /** Stops new work on a job and, once nothing is running, closes it so the unused deposit comes back. */
  async stopJob(jobId: bigint) {
    const { account, wallet } = this.me();
    const swarm = this.swarmAddress();
    const job = await this.client.readContract({ address: swarm, abi: swarmMarketAbi, functionName: "getJob", args: [jobId] });
    if (job.renter.toLowerCase() !== account.address.toLowerCase()) throw new GridError(`Job ${jobId} belongs to another wallet.`);
    if (job.closed) return { jobId: jobId.toString(), state: "closed", note: "Already closed." };
    const finished = job.resolved === job.taskCount;
    const txs: Hex[] = [];
    let cancelled = job.cancelled;
    if (!finished && !cancelled) {
      const tx = await wallet.writeContract({ address: swarm, abi: swarmMarketAbi, functionName: "cancelJob", args: [jobId] });
      await this.confirm(tx);
      txs.push(tx);
      cancelled = true;
    }
    const after = await this.client.readContract({ address: swarm, abi: swarmMarketAbi, functionName: "getJob", args: [jobId] });
    const now = Math.floor(Date.now() / 1000);
    if (!finished && now <= Number(after.lastLeaseEnd)) {
      return {
        jobId: jobId.toString(),
        state: "cancelled",
        txs,
        note: `Leased tasks may still finish. Call stop_swarm_job again after ${new Date(Number(after.lastLeaseEnd) * 1000).toISOString()} to close the job and get the rest of the deposit back.`,
      };
    }
    const tx = await wallet.writeContract({ address: swarm, abi: swarmMarketAbi, functionName: "closeJob", args: [jobId] });
    const receipt = await this.confirm(tx);
    txs.push(tx);
    const [closed] = parseEventLogs({ abi: swarmMarketAbi, eventName: "JobClosed", logs: receipt.logs });
    return {
      jobId: jobId.toString(),
      state: "closed",
      refundedEth: eth(closed.args.refunded),
      txs,
      next: "The refund is held by SwarmMarket; call withdraw to move it to the wallet.",
    };
  }
}

// ---------------------------------------------------------------- helpers

type ChainMachine = { available: boolean; activeRental: bigint };

/** Same rule as the web market: free means listed, not rented, reachable and allowed to rent. */
function machineStatus(meta: MachineMetadata | null, machine: ChainMachine, rentable: boolean, reachable: boolean | "insecure"): Machine["status"] {
  if (!meta) return "no-details";
  if (meta.p2p?.direct === false) return "swarm-only";
  if (!machine.available) return "paused";
  if (machine.activeRental !== 0n) return "rented";
  if (reachable === "insecure") return "unreachable";
  if (!reachable) return "offline";
  if (!rentable) return "needs-bond";
  return "available";
}

function describe(
  id: bigint,
  meta: MachineMetadata | null,
  host: Address,
  pricePerHour: bigint,
  status: Machine["status"],
  hostBonded: boolean,
  maxHours: number,
): Machine {
  const gpus = Math.max(1, meta?.gpuCount ?? 1);
  return {
    id: id.toString(),
    name: meta?.name || `Machine ${id}`,
    gpu: meta ? (meta.gpuCount > 0 ? meta.gpu : "none") : "unknown",
    gpuModel: gpuModel(meta),
    gpuCount: meta?.gpuCount ?? 0,
    vramGb: meta?.vramGb ?? 0,
    cpu: meta?.cpu ?? "",
    ramGb: meta?.ramGb ?? 0,
    diskGb: meta?.diskGb ?? 0,
    pricePerHourEth: eth(pricePerHour),
    pricePerGpuHourEth: eth(pricePerHour / BigInt(gpus)),
    status,
    free: status === "available",
    host,
    hostBonded,
    maxHours,
    endpoint: meta?.endpoint ?? null,
  };
}

/** The result at least two runs agree on, if any. */
function agreedResult(results: readonly Hex[]): Hex | null {
  const set = results.filter((r) => r !== zeroHash);
  for (const r of set) if (set.filter((x) => x === r).length >= 2) return r;
  return null;
}

/** One entry per GPU model and memory size, with how many machines are free and the cheapest free GPU-hour. */
export function gpuIndex(machines: Machine[]) {
  const groups = new Map<string, { model: string; vramGb: number; machines: number; free: number; cheapest: bigint | null }>();
  for (const m of machines) {
    const key = `${m.gpuModel}|${m.vramGb}`;
    const g = groups.get(key) ?? { model: m.gpuModel, vramGb: m.vramGb, machines: 0, free: 0, cheapest: null };
    g.machines++;
    if (m.free) {
      g.free++;
      const p = parseEther(m.pricePerGpuHourEth);
      if (g.cheapest === null || p < g.cheapest) g.cheapest = p;
    }
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => (b.free > 0 ? 1 : 0) - (a.free > 0 ? 1 : 0) || b.vramGb - a.vramGb)
    .map((g) => ({ ...g, cheapestFreePerGpuHourEth: g.cheapest === null ? null : eth(g.cheapest), cheapest: undefined }));
}
