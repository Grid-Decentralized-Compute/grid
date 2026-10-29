import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Address, formatEther, keccak256, parseEventLogs, toBytes } from "viem";
import {
  MAX_OUTPUT_BYTES,
  parseManifest,
  resultHash,
  SWARM_MAX_BATCH,
  type SwarmManifest,
  stakeRegistryAbi,
  swarmMarketAbi,
} from "@grid/shared";
import type { Chain } from "./chain";
import type { Config } from "./config";
import { log } from "./log";

/** How many tasks of a job to scan per claimable() call, and how many recent jobs to consider. */
const SCAN = 2_000;
const RECENT_JOBS = 25;

type Claim = { task: number; slot: number; leaseEnd: number };

/**
 * Swarm mode: while the machine is not rented, take tasks from open jobs, run them, keep the
 * outputs for the renter to fetch and submit their hashes. Each round is: find a job with work
 * for this host, claim a small batch, run it, submit it.
 */
export class SwarmWorker {
  private readonly swarm: { abi: typeof swarmMarketAbi; address: Address };
  private readonly manifests = new Map<bigint, SwarmManifest | null>();
  private readonly cursors = new Map<bigint, number>();
  private readonly resultsDir: string;
  private warnedBond = false;

  constructor(
    private readonly config: Config,
    private readonly chain: Chain,
    private readonly docker: boolean,
    private readonly hasGpu: boolean,
  ) {
    this.swarm = { abi: swarmMarketAbi, address: config.swarm! };
    this.resultsDir = join(config.stateDir, "results", config.swarm!.toLowerCase());
  }

  /** Publishes where renters fetch this host's outputs. */
  async register() {
    const current = await this.chain.publicClient.readContract({
      ...this.swarm,
      functionName: "workerEndpoint",
      args: [this.chain.address],
    });
    if (current !== this.config.publicUrl) {
      await this.chain.send({ ...this.swarm, functionName: "registerWorker", args: [this.config.publicUrl] });
      log(`swarm: registered ${this.config.publicUrl} for results`);
    }
    log(
      `swarm: on (${this.docker ? "docker" : "simulated"} tasks, batch ${this.config.swarmBatch}, ` +
        `min ${formatEther(this.config.swarmMinPriceWei)} ETH/run${this.config.swarmCheat ? ", CHEATING for tests" : ""})`,
    );
  }

  /** One round of work. Returns true when tasks were run. */
  async round(): Promise<boolean> {
    const pick = await this.findWork();
    if (!pick) return false;
    const { jobId, tasks, manifest } = pick;

    const receipt = await this.chain.send({ ...this.swarm, functionName: "claim", args: [jobId, tasks] });
    const claims: Claim[] = parseEventLogs({ abi: swarmMarketAbi, eventName: "Claimed", logs: receipt.logs })
      .filter((e) => e.args.host.toLowerCase() === this.chain.address.toLowerCase())
      .map((e) => ({ task: e.args.task, slot: e.args.slot, leaseEnd: Number(e.args.leaseEnd) }));
    if (claims.length === 0) return false; // another host was faster
    log(`swarm: job ${jobId} — claimed ${claims.length} task(s): ${claims.map((c) => c.task).join(", ")}`);

    const done: number[] = [];
    const hashes: `0x${string}`[] = [];
    for (const c of claims) {
      const secondsLeft = c.leaseEnd - Date.now() / 1000 - 15;
      if (secondsLeft <= 0) break;
      const output = await this.run(manifest, manifest.tasks[c.task] ?? "", c.task, secondsLeft * 1000);
      this.store(jobId, c.task, output);
      done.push(c.task);
      hashes.push(resultHash(output));
    }
    if (done.length > 0) {
      await this.chain.send({ ...this.swarm, functionName: "submit", args: [jobId, done, hashes] });
      log(`swarm: job ${jobId} — submitted ${done.length} result(s)`);
    }
    return done.length > 0;
  }

  /** The output this host produced for a task, if it ran it. */
  readResult(swarm: string, jobId: string, task: string): string | null {
    if (swarm.toLowerCase() !== this.config.swarm!.toLowerCase()) return null;
    if (!/^\d+$/.test(jobId) || !/^\d+$/.test(task)) return null;
    try {
      return readFileSync(join(this.resultsDir, jobId, `${task}.out`), "utf8");
    } catch {
      return null;
    }
  }

  private async findWork() {
    const client = this.chain.publicClient;
    const count = await client.readContract({ ...this.swarm, functionName: "jobCount" });
    if (count === 0n) return null;
    // Swarm work needs a bond whenever bonding is on: replicas catch a cheat, the bond makes it cost.
    const eligible = await client.readContract({
      abi: stakeRegistryAbi,
      address: this.config.stake,
      functionName: "isEligible",
      args: [this.chain.address],
    });
    if (!eligible) {
      if (!this.warnedBond) log("swarm: waiting — this host needs a GRID bond before it can take swarm tasks");
      this.warnedBond = true;
      return null;
    }
    this.warnedBond = false;
    const jobs = await client.readContract({
      ...this.swarm,
      functionName: "getJobs",
      args: [0n, BigInt(RECENT_JOBS)],
    });
    // Oldest open job first, so work is finished in the order it was posted.
    for (const { id, job } of [...jobs].reverse()) {
      if (job.cancelled || job.closed || job.resolved === job.taskCount) continue;
      if (job.pricePerRun < this.config.swarmMinPriceWei) continue;
      const manifest = await this.manifest(id, job.postedBlock, job.manifestHash);
      if (!manifest || (manifest.gpu && !this.hasGpu)) continue;

      // Scan the job in windows, remembering where the last search stopped.
      let from = this.cursors.get(id) ?? 0;
      for (let scanned = 0; scanned < job.taskCount; scanned += SCAN) {
        const tasks = await client.readContract({
          ...this.swarm,
          functionName: "claimable",
          args: [id, this.chain.address, from, SCAN, Math.min(this.config.swarmBatch, SWARM_MAX_BATCH)],
        });
        if (tasks.length > 0) {
          this.cursors.set(id, from);
          return { jobId: id, tasks: [...tasks], manifest };
        }
        from = from + SCAN >= job.taskCount ? 0 : from + SCAN;
      }
    }
    return null;
  }

  /** Reads a job's manifest from its JobPosted event and checks it against the stored hash. */
  private async manifest(jobId: bigint, block: bigint, hash: `0x${string}`): Promise<SwarmManifest | null> {
    if (this.manifests.has(jobId)) return this.manifests.get(jobId)!;
    const [event] = await this.chain.publicClient.getContractEvents({
      ...this.swarm,
      eventName: "JobPosted",
      args: { jobId },
      fromBlock: block,
      toBlock: block,
    });
    let manifest: SwarmManifest | null = null;
    if (event && keccak256(event.args.manifest!) === hash) manifest = parseManifest(event.args.manifest!);
    if (!manifest) log(`swarm: job ${jobId} has no readable manifest — skipping it`);
    this.manifests.set(jobId, manifest);
    return manifest;
  }

  private async run(manifest: SwarmManifest, input: string, task: number, timeoutMs: number): Promise<string> {
    let output: string;
    if (!this.docker) {
      // Simulated: a deterministic stand-in, so honest hosts agree without running containers.
      const digest = keccak256(toBytes(`${manifest.image}\n${manifest.command}\n${input}`)).slice(2, 18);
      output = `simulated · task ${task} · ${input.length} bytes in · ${digest}\n`;
    } else {
      output = await this.container(manifest, input, timeoutMs);
    }
    if (this.config.swarmCheat) output += `cheat ${randomBytes(4).toString("hex")}\n`;
    return output;
  }

  /** Runs the task in a throwaway container: input on stdin, stdout is the output. */
  private container(manifest: SwarmManifest, input: string, timeoutMs: number): Promise<string> {
    const args = ["run", "--rm", "-i", "--memory", "8g", "--pids-limit", "512"];
    if (!this.config.swarmNetwork) args.push("--network", "none");
    if (manifest.gpu) args.push("--gpus", "all");
    args.push(manifest.image, "sh", "-c", manifest.command);

    return new Promise((resolve) => {
      const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (d: Buffer) => {
        if (out.length < MAX_OUTPUT_BYTES) out += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        if (err.length < 4_000) err += d.toString("utf8");
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        out = out.slice(0, MAX_OUTPUT_BYTES);
        // A failure is reported the same way by every honest host, so replicas still agree on it.
        if (signal) resolve(`error: timed out\n`);
        else if (code !== 0) resolve(`error: exit ${code}\n${out}`);
        else resolve(out);
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve(`error: ${e.message}\n`);
      });
      child.stdin.end(input);
    });
  }

  private store(jobId: bigint, task: number, output: string) {
    const dir = join(this.resultsDir, jobId.toString());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${task}.out`), output);
  }
}
