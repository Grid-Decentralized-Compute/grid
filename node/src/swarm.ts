import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { type Address, formatEther, keccak256, parseEventLogs, toBytes, zeroHash } from "viem";
import {
  MAX_OUTPUT_BYTES,
  parseManifest,
  SWARM_MAX_BATCH,
  type SwarmManifest,
  stakeRegistryAbi,
  swarmMarketAbi,
} from "@grid/shared";
import type { Chain } from "./chain";
import type { Config } from "./config";
import { log } from "./log";
import { dockerEnv } from "./sessions";

/** How many tasks of a job to scan per claimable() call, and how many recent jobs to consider. */
const SCAN = 2_000;
const RECENT_JOBS = 25;

/**
 * Images strangers' jobs may name: a plain registry reference, optionally pinned by digest. Never
 * anything starting with "-", which docker would read as a flag.
 */
const IMAGE = /^[a-z0-9][a-z0-9._\/-]{0,200}(:[A-Za-z0-9._-]{1,128})?(@sha256:[a-f0-9]{64})?$/;
/** The worker stops taking tasks when the disk holding its state has less free space than this. */
const MIN_FREE_BYTES = 10 * 2 ** 30;
/** Rough gas for claiming, running and settling one task, to skip jobs that pay less than they cost. */
const GAS_PER_TASK = 250_000n;
/** How often a running task checks whether a direct rental has started and it must make way. */
const YIELD_CHECK_MS = 5_000;

type Claim = { task: number; slot: number; leaseEnd: number };
/** A committed result waiting to be revealed; kept on disk so a restart cannot lose it. */
type Reveal = { jobId: string; task: number; result: `0x${string}`; salt: `0x${string}`; at: number };

/** Gas set aside per submitted task for settling it, in case the other replica lands first. */
const SETTLE_GAS_PER_TASK = 120_000n;
/** A submit that keeps failing on-chain is given up after this many tries. */
const MAX_SUBMIT_TRIES = 5;

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
  private readonly underpaid = new Set<bigint>();
  /** Commits computed but not yet accepted on-chain, oldest first. */
  private readonly unsent: { jobId: bigint; tasks: number[]; hashes: `0x${string}`[]; tries: number }[] = [];

  constructor(
    private readonly config: Config,
    private readonly chain: Chain,
    private readonly docker: boolean,
    private readonly hasGpu: boolean,
    /** True when a direct rental has started: swarm work stops at once, the renter comes first. */
    private readonly shouldYield: () => Promise<boolean> = async () => false,
  ) {
    this.swarm = { abi: swarmMarketAbi, address: config.swarm! };
    this.resultsDir = join(config.stateDir, "results", config.swarm!.toLowerCase());
    this.revealsFile = join(config.stateDir, `reveals-${config.swarm!.toLowerCase()}.json`);
  }

  private readonly revealsFile: string;

  private endpoint: string | null = null;

  /** Publishes where renters fetch this host's outputs; with no address the node does not take tasks. */
  async register(endpoint: string | null) {
    this.endpoint = endpoint;
    if (!endpoint) {
      log("swarm: waiting for an address renters can reach (a relay) before taking tasks");
      return;
    }
    const current = await this.chain.publicClient.readContract({
      ...this.swarm,
      functionName: "workerEndpoint",
      args: [this.chain.address],
    });
    if (current !== endpoint) {
      await this.chain.send({ ...this.swarm, functionName: "registerWorker", args: [endpoint] });
      log(`swarm: results served at ${endpoint}`);
    }
    log(
      `swarm: on (${this.docker ? "docker" : "simulated"} tasks, batch ${this.config.swarmBatch}, ` +
        `min ${formatEther(this.config.swarmMinPriceWei)} ETH/run${this.config.swarmCheat ? ", CHEATING for tests" : ""})`,
    );
  }

  /** One round of work. Returns true when tasks were run. */
  async round(): Promise<boolean> {
    if (!this.endpoint) return false;
    // Earlier work comes first: a host is paid only once its result is revealed, and the
    // renter's job waits on it. Commits not yet on-chain go out, then anything now revealable.
    if (this.unsent.length > 0) return this.flush();
    if (await this.revealReady()) return true;
    if (!this.roomToWork()) return false;
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
    const sealed: Reveal[] = [];
    for (const c of claims) {
      const secondsLeft = c.leaseEnd - Date.now() / 1000 - 15;
      if (secondsLeft <= 0) break;
      if (await this.shouldYield()) break;
      const output = await this.run(manifest, manifest.tasks[c.task] ?? "", c.task, secondsLeft * 1000);
      if (output === null) break; // made way for a direct rental; the lease passes to another host
      this.store(jobId, c.task, output);
      // Commit-reveal: the chain first sees only a salted commitment, so no other host can copy
      // this result; it is revealed once the other replica has committed too.
      const result = keccak256(output);
      const salt = `0x${randomBytes(32).toString("hex")}` as const;
      const commit = await this.chain.publicClient.readContract({
        ...this.swarm,
        functionName: "commitHash",
        args: [jobId, c.task, this.chain.address, result, salt],
      });
      sealed.push({ jobId: jobId.toString(), task: c.task, result, salt, at: Date.now() });
      done.push(c.task);
      hashes.push(commit);
    }
    if (done.length > 0) {
      // Saved before the commit is sent: a node that crashes in between can still reveal.
      this.saveReveals([...this.loadReveals(), ...sealed]);
      this.unsent.push({ jobId, tasks: done, hashes, tries: 0 });
      await this.flush();
    }
    return done.length > 0;
  }

  /**
   * Reveals committed results whose reveal is open (both replicas committed, or this is the
   * tie-break run). Results whose task has settled, or whose run another host took over, are
   * forgotten. Returns true when something was revealed.
   */
  private async revealReady(): Promise<boolean> {
    const pending = this.loadReveals();
    if (pending.length === 0) return false;
    const me = this.chain.address.toLowerCase();
    const keep: Reveal[] = [];
    const ready = new Map<string, Reveal[]>();
    for (const r of pending) {
      if (Date.now() - r.at > 3 * 86_400_000) continue; // long gone
      const [runs, state] = await this.chain.publicClient.readContract({
        ...this.swarm,
        functionName: "getTask",
        args: [BigInt(r.jobId), r.task],
      });
      if (state !== 0) continue; // settled
      const slot = runs.findIndex((run) => run.host.toLowerCase() === me);
      if (slot === -1) continue; // taken over
      const run = runs[slot];
      if (run.result !== zeroHash) continue; // already revealed
      if (run.commit === zeroHash) {
        keep.push(r); // the commit is still on its way
        continue;
      }
      const open = slot === 2 || runs[1 - slot].commit !== zeroHash;
      if (!open) {
        keep.push(r);
        continue;
      }
      ready.set(r.jobId, [...(ready.get(r.jobId) ?? []), r]);
    }

    let revealed = false;
    for (const [jobId, items] of ready) {
      const call = {
        ...this.swarm,
        functionName: "reveal",
        args: [BigInt(jobId), items.map((r) => r.task), items.map((r) => r.result), items.map((r) => r.salt)],
      } as const;
      try {
        await this.chain.publicClient.simulateContract({ ...call, account: this.chain.address });
      } catch (e) {
        log(`swarm: job ${jobId} — dropped ${items.length} reveal(s) the contract no longer takes (${(e as Error).message.split("\n")[0]})`);
        continue;
      }
      try {
        // Revealing settles the task, which costs more when the other replica's result is in.
        await this.chain.send(call, SETTLE_GAS_PER_TASK * BigInt(items.length));
        log(`swarm: job ${jobId} — revealed ${items.length} result(s)`);
        revealed = true;
      } catch (e) {
        keep.push(...items); // retried next round with a fresh estimate
        log(`swarm: job ${jobId} — reveal failed, will retry: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    this.saveReveals(keep);
    return revealed;
  }

  private loadReveals(): Reveal[] {
    try {
      return JSON.parse(readFileSync(this.revealsFile, "utf8")) as Reveal[];
    } catch {
      return [];
    }
  }

  private saveReveals(list: Reveal[]) {
    mkdirSync(this.config.stateDir, { recursive: true });
    writeFileSync(this.revealsFile, JSON.stringify(list), { mode: 0o600 });
  }

  /**
   * Submits queued commits. A submit that fails on-chain stays queued and is retried next round,
   * with a fresh gas estimate; one the contract refuses outright (the job was closed) is dropped.
   */
  private async flush(): Promise<boolean> {
    let sent = false;
    while (this.unsent.length > 0) {
      const batch = this.unsent[0];
      const call = { ...this.swarm, functionName: "submit", args: [batch.jobId, batch.tasks, batch.hashes] } as const;
      try {
        await this.chain.publicClient.simulateContract({ ...call, account: this.chain.address });
      } catch (e) {
        this.unsent.shift();
        log(`swarm: job ${batch.jobId} — dropped ${batch.tasks.length} result(s) the contract no longer takes (${(e as Error).message.split("\n")[0]})`);
        continue;
      }
      try {
        await this.chain.send(call);
      } catch (e) {
        batch.tries++;
        if (batch.tries >= MAX_SUBMIT_TRIES) {
          this.unsent.shift();
          log(`swarm: job ${batch.jobId} — gave up submitting ${batch.tasks.length} result(s) after ${batch.tries} tries`);
        }
        throw e;
      }
      this.unsent.shift();
      log(`swarm: job ${batch.jobId} — committed ${batch.tasks.length} result(s)${batch.tries ? ` (try ${batch.tries + 1})` : ""}`);
      sent = true;
    }
    return sent;
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
    const gasPrice = await client.getGasPrice();
    // Oldest open job first, so work is finished in the order it was posted.
    for (const { id, job } of [...jobs].reverse()) {
      if (job.cancelled || job.closed || job.resolved === job.taskCount) continue;
      if (job.pricePerRun < this.config.swarmMinPriceWei) continue;
      // Skip jobs that pay less per task than the gas to claim and settle it would cost.
      if (job.pricePerRun < gasPrice * GAS_PER_TASK) {
        if (!this.underpaid.has(id)) log(`swarm: skipping job ${id}: ${formatEther(job.pricePerRun)} ETH per run is less than the gas to run it`);
        this.underpaid.add(id);
        continue;
      }
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
    if (manifest && !IMAGE.test(manifest.image)) {
      log(`swarm: job ${jobId} names an image this host will not run — skipping it`);
      manifest = null;
    } else if (!manifest) log(`swarm: job ${jobId} has no readable manifest — skipping it`);
    this.manifests.set(jobId, manifest);
    return manifest;
  }

  /** Runs one task. Null when it was stopped to make way for a direct rental. */
  private async run(manifest: SwarmManifest, input: string, task: number, timeoutMs: number): Promise<Uint8Array | null> {
    let output: Uint8Array | null;
    if (!this.docker) {
      // Simulated: a deterministic stand-in, so honest hosts agree without running containers.
      const digest = keccak256(toBytes(`${manifest.image}\n${manifest.command}\n${input}`)).slice(2, 18);
      output = toBytes(`simulated · task ${task} · ${input.length} bytes in · ${digest}\n`);
    } else {
      output = await this.container(manifest, input, timeoutMs);
    }
    if (output && this.config.swarmCheat) output = Buffer.concat([output, Buffer.from(`cheat ${randomBytes(4).toString("hex")}\n`)]);
    return output;
  }

  /**
   * Runs the task in a throwaway, named container: input on stdin, stdout (raw bytes, at most
   * MAX_OUTPUT_BYTES) is the output. Strangers' code runs here, so the container has no network
   * (unless the host allows it), no capabilities, no privilege escalation, bounded memory,
   * processes and CPU, no core dumps and no docker log. On timeout, or when a direct rental starts,
   * the container itself is killed, not just the docker client.
   */
  private container(manifest: SwarmManifest, input: string, timeoutMs: number): Promise<Uint8Array | null> {
    const name = `grid-swarm-${randomBytes(6).toString("hex")}`;
    const args = [
      "run", "--rm", "-i", "--name", name,
      "--memory", "8g", "--memory-swap", "8g", "--pids-limit", "512",
      "--cpus", String(Math.max(1, Math.min(4, os.cpus().length - 1))),
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--ulimit", "core=0", "--log-driver", "none",
    ];
    if (!this.config.swarmNetwork) args.push("--network", "none");
    if (manifest.gpu) args.push("--gpus", "all");
    args.push(manifest.image, "sh", "-c", manifest.command);

    return new Promise((resolve) => {
      const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], env: dockerEnv() });
      const chunks: Buffer[] = [];
      let size = 0;
      let stopped: "timeout" | "yield" | null = null;
      const kill = (why: "timeout" | "yield") => {
        stopped ??= why;
        execFile("docker", ["kill", name], { env: dockerEnv() }, () => {});
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => kill("timeout"), timeoutMs);
      const yieldCheck = setInterval(() => {
        void this.shouldYield().then((y) => y && kill("yield"), () => {});
      }, YIELD_CHECK_MS);
      child.stdout.on("data", (d: Buffer) => {
        if (size < MAX_OUTPUT_BYTES) chunks.push(d.subarray(0, MAX_OUTPUT_BYTES - size));
        size += d.length;
      });
      // Read and dropped, so a chatty task cannot block on a full pipe.
      child.stderr.on("data", () => {});
      child.stdin.on("error", () => {
        // the task exited without reading its input: not an error for us
      });
      const finish = (result: Uint8Array | null) => {
        clearTimeout(timer);
        clearInterval(yieldCheck);
        resolve(result);
      };
      child.on("close", (code) => {
        const out = Buffer.concat(chunks);
        // A failure is reported the same way by every honest host, so replicas still agree on it.
        if (stopped === "yield") finish(null);
        else if (stopped === "timeout") finish(Buffer.from("error: timed out\n"));
        else if (code !== 0) finish(Buffer.concat([Buffer.from(`error: exit ${code}\n`), out]));
        else finish(out);
      });
      child.on("error", (e) => {
        finish(Buffer.from(`error: ${e.message}\n`));
      });
      child.stdin.end(input);
    });
  }

  private store(jobId: bigint, task: number, output: Uint8Array) {
    const dir = join(this.resultsDir, jobId.toString());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${task}.out`), output);
  }

  /** Removes task containers left by an earlier run of the node (a crash or a kill mid-task). */
  async sweep() {
    if (!this.docker) return;
    await new Promise<void>((done) => {
      execFile("docker", ["ps", "-aq", "--filter", "name=^grid-swarm-"], { env: dockerEnv() }, (err, stdout) => {
        const ids = err ? [] : stdout.split("\n").filter(Boolean);
        if (ids.length === 0) return done();
        log(`swarm: removing ${ids.length} leftover task container(s)`);
        execFile("docker", ["rm", "-f", ...ids], { env: dockerEnv() }, () => done());
      });
    });
  }

  private lastCleanup = 0;
  private warnedDisk = false;

  /**
   * Keeps the disk in check: outputs older than GRID_SWARM_KEEP_HOURS are deleted (renters fetch
   * them while the job runs), and no new work is taken while free space is low. Cleans at most hourly.
   */
  private roomToWork(): boolean {
    const now = Date.now();
    if (now - this.lastCleanup > 3_600_000) {
      this.lastCleanup = now;
      const cutoff = now - this.config.swarmKeepHours * 3_600_000;
      try {
        for (const job of readdirSync(this.resultsDir)) {
          const dir = join(this.resultsDir, job);
          if (statSync(dir).mtimeMs < cutoff) rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        // no results yet
      }
    }
    try {
      mkdirSync(this.resultsDir, { recursive: true });
      const fs = statfsSync(this.resultsDir);
      if (Number(fs.bavail) * Number(fs.bsize) < MIN_FREE_BYTES) {
        if (!this.warnedDisk) log("swarm: paused — less than 10 GB of free disk space");
        this.warnedDisk = true;
        return false;
      }
    } catch {
      // statfs unsupported here: carry on
    }
    this.warnedDisk = false;
    return true;
  }
}
