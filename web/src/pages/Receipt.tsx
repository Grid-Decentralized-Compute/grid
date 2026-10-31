import { type ReactNode, useState } from "react";
import { zeroAddress, zeroHash } from "viem";
import { useChainId, useChains, usePublicClient, useReadContract } from "wagmi";
import { swarmMarketAbi } from "@grid/shared";
import { Button, linkClass, Section, Stat, Status, type Tone } from "../components/ui";
import { useDeployment } from "../contracts";
import { fmtDate, fmtEth, shortAddr, shortError } from "../lib/format";
import { checkTaskOutput, type OutputCheck, type OutputSource } from "../lib/outputs";
import { TaskState, useDecision } from "../lib/receipt";
import { Link } from "../router";

type Hex = `0x${string}`;

const SLOTS = ["Replica 1", "Replica 2", "Tie-break"];

/** The output is shown up to this many characters; the download always has all of it. */
const PREVIEW_CHARS = 20_000;

/** Columns of the runs table, from tablet width up; on a phone each run stacks. */
const RUN_COLS = "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,1.3fr)_13rem] sm:items-center sm:gap-x-6";

const shortHash = (hash: string) => `${hash.slice(0, 10)}…${hash.slice(-6)}`;

type Verification =
  | { phase: "idle" }
  | { phase: "working" }
  | { phase: "done"; check: OutputCheck; hosts: number }
  | { phase: "error"; message: string };

/**
 * A shareable compute receipt for one swarm task: which hosts ran it, what each of them reported, which
 * result the contract settled on and where that was recorded. Everything on it comes from the chain,
 * and the output itself can be fetched from a host and checked against the recorded hash.
 */
export function ReceiptPage({ jobId, task }: { jobId: bigint; task: number }) {
  const deployment = useDeployment();
  const swarm = deployment?.SwarmMarket;
  const chainId = useChainId();
  const client = usePublicClient({ chainId });
  const chain = useChains().find((c) => c.id === chainId);
  const explorer = chain?.blockExplorers?.default.url;
  const [verification, setVerification] = useState<Verification>({ phase: "idle" });

  const { data: job, error: jobError } = useReadContract({
    abi: swarmMarketAbi,
    address: swarm,
    functionName: "getJob",
    args: [jobId],
    // A job that does not exist reverts; one retry covers a flaky node without making a wrong link wait.
    query: { enabled: !!swarm, retry: 1 },
  });
  const inRange = !!job && task < job.taskCount;
  const { data: taskData, error: taskError } = useReadContract({
    abi: swarmMarketAbi,
    address: swarm,
    functionName: "getTask",
    args: [jobId, task],
    query: { enabled: !!swarm && inRange, retry: 1, refetchInterval: (query) => (query.state.data?.[1] === TaskState.Open ? 5_000 : false) },
  });
  const state = taskData?.[1];
  const { data: decided, error: decisionError, isLoading: decisionLoading } = useDecision(swarm, jobId, task, state, job?.postedBlock);

  if (!swarm) return <p className="text-muted">Swarm jobs are not available on this network, so there is no receipt to show.</p>;
  if (jobError) {
    return (
      <p className="text-muted">
        There is no job {jobId.toString()} on this network, or the node could not be reached.{" "}
        <Link href="/swarm" className={linkClass}>
          Back to the swarm
        </Link>
      </p>
    );
  }
  if (!job) return <p className="text-muted">Reading job {jobId.toString()}…</p>;
  if (!inRange) {
    return (
      <p className="text-muted">
        Job {jobId.toString()} has {job.taskCount.toLocaleString("en-US")} {job.taskCount === 1 ? "task, numbered 0" : `tasks, numbered 0 to ${job.taskCount - 1}`}; there is no task {task}.{" "}
        <Link href={`/jobs/${jobId}`} className={linkClass}>
          Back to the job
        </Link>
      </p>
    );
  }
  if (taskError) return <p className="text-bad">Could not read this task: {shortError(taskError).split("\n")[0]}</p>;
  if (!taskData) return <p className="text-muted">Reading task {task}…</p>;

  const [runs] = taskData;
  const done = state === TaskState.Done;
  const failed = state === TaskState.Failed;
  // The contract settles a task when two runs match, either both replicas or the tie-break and one of them.
  const final: Hex | null = done ? (runs[0].result === runs[1].result ? runs[0].result : runs[2].result) : null;
  const tieBroken = done && runs[0].result !== runs[1].result;
  const agreeing = final ? runs.filter((r) => r.result === final) : [];
  const faults = decided?.faults ?? [];
  const faultedHosts = new Set(faults.map((f) => f.host.toLowerCase()));
  const shownHosts = new Set(runs.map((r) => r.host.toLowerCase()));
  // A host that committed and then missed its reveal deadline lost its run to another host; the run is gone but the fault stays on record.
  const replaced = faults.filter((f) => !shownHosts.has(f.host.toLowerCase()));

  const [tone, stateLabel]: [Tone, string] = done
    ? ["ok", tieBroken ? "Settled by tie-break" : "Settled"]
    : failed
      ? ["bad", "Failed"]
      : ["busy", "Not settled yet"];

  const proves = done
    ? tieBroken
      ? "Two host accounts gave different answers, so the contract brought in a third. Two of the three revealed the same result, which the contract recorded and paid for; the odd one out was marked with a fault. Every host committed to its answer before any answer was revealed, so none could copy another. The result is a hash of the output, so anyone holding the output can hash it and compare."
      : "Two different host accounts each ran this task on their own and committed to an answer before either revealed it, so neither could copy the other. They then revealed the same result, and the contract recorded it and paid both. The result is a hash of the output, so anyone holding the output can hash it and compare."
    : failed
      ? "All three runs returned different results, so the contract recorded a failure for this task and paid no host. There is no agreed result for this receipt to vouch for."
      : "Nobody has settled this task yet. This receipt becomes a proof once two hosts reveal the same result; until then it shows how far the runs have got.";
  const notProves =
    "It does not prove that the task was meaningful, that the program does what its author meant, or that the two hosts are run by different people: the contract sees separate accounts, not who is behind them. Agreement shows the computation was reproducible, not that it is right.";

  const verified = verification.phase === "done" && verification.check.status === "verified" ? verification.check : null;

  async function verify() {
    if (!final || !client) return;
    setVerification({ phase: "working" });
    try {
      const sources: OutputSource[] = [];
      for (const host of new Set(agreeing.map((r) => r.host))) {
        const endpoint = await client.readContract({ address: swarm!, abi: swarmMarketAbi, functionName: "workerEndpoint", args: [host] });
        if (endpoint) sources.push({ host, endpoint });
      }
      const check = await checkTaskOutput(swarm!, jobId, task, final, sources);
      setVerification({ phase: "done", check, hosts: sources.length });
    } catch (e) {
      setVerification({ phase: "error", message: shortError(e) });
    }
  }

  function download(bytes: Uint8Array<ArrayBuffer>) {
    const url = URL.createObjectURL(new Blob([bytes], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `grid-job-${jobId}-task-${task}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <Link href={`/jobs/${jobId}`} className="text-[13px] text-muted transition-colors hover:text-steel">
        ← Job {jobId.toString()}
      </Link>
      <p className="engraved mt-6 text-steel">Compute receipt</p>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <h1 className="font-serif text-[34px] font-light leading-[1.1] tracking-[-0.01em]">
          Job {jobId.toString()} <span className="text-faint">·</span> Task {task}
        </h1>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <Status tone={tone}>{stateLabel}</Status>
          <CopyLink />
        </div>
      </div>

      <div className="mt-8 grid gap-x-12 gap-y-6 border-y border-line py-6 sm:grid-cols-2">
        <div>
          <p className="engraved text-faint">{done ? "What this proves" : failed ? "What this shows" : "What this will prove"}</p>
          <p className="mt-2 text-[14px]">{proves}</p>
        </div>
        <div>
          <p className="engraved text-faint">What it does not prove</p>
          <p className="mt-2 text-[14px] text-muted">{notProves}</p>
        </div>
      </div>

      <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
        <Stat label="Renter">
          <Addr address={job.renter} explorer={explorer} />
        </Stat>
        <Stat label="Price per run">{fmtEth(job.pricePerRun, 8)} ETH</Stat>
        <Stat label="Paid for this task">{done ? `${fmtEth(job.pricePerRun * 2n, 8)} ETH` : "—"}</Stat>        <Stat label="Tasks in job">{job.taskCount.toLocaleString("en-US")}</Stat>
      </dl>

      <div className="mt-14">
        <Section title="Runs" aside={<span className="engraved text-faint">Two replicas, one tie-break</span>}>
          <div className={`engraved hidden border-b border-line py-2.5 text-faint sm:grid ${RUN_COLS}`}>
            <span>Run</span>
            <span>Host</span>
            <span>Result hash</span>
            <span>Verdict</span>
          </div>
          {runs.map((run, slot) => {
            const [runTone, label] = verdict(run, slot, final, state, faultedHosts);
            const used = run.host !== zeroAddress;
            return (
              <div key={slot} className={`grid gap-y-1 border-b border-line py-3.5 ${RUN_COLS}`}>
                <span className="text-[13px] sm:col-start-1 sm:row-start-1">{SLOTS[slot]}</span>
                <span className="justify-self-end sm:col-start-4 sm:row-start-1 sm:justify-self-start">
                  <Status tone={runTone}>{runTone === "bad" ? <span className="text-bad">{label}</span> : label}</Status>
                </span>
                <span className="col-span-2 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1">
                  {used ? <Addr address={run.host} explorer={explorer} /> : <span className="text-faint">—</span>}
                </span>
                <span className="col-span-2 flex min-w-0 items-baseline gap-4 sm:col-span-1 sm:col-start-3 sm:row-start-1">
                  {run.result === zeroHash ? (
                    <span className="text-faint">—</span>
                  ) : (
                    <>
                      <span className="tnum font-mono text-[13px]" title={run.result}>
                        {shortHash(run.result)}
                      </span>
                      <Copy value={run.result} />
                    </>
                  )}
                </span>
              </div>
            );
          })}
          {replaced.map((f) => (
            <p key={f.host + f.result} className="border-b border-line py-3.5 text-[13px] text-muted">
              <Addr address={f.host} explorer={explorer} /> took a run of this task, committed to an answer and missed the deadline to reveal
              it. Another host took the run over, and a fault was recorded against it.
            </p>
          ))}
          {decisionError && <p className="pt-3 text-[13px] text-muted">Faults could not be read from the chain right now: {shortError(decisionError).split("\n")[0]}</p>}
        </Section>

        <Section title="Result">
          {final ? (
            <>
              <p className="break-all font-mono text-[14px]">{final}</p>
              <div className="mt-3 flex items-center gap-5">
                <Copy value={final} label="Copy hash" />
              </div>
              <p className="mt-3 text-[13px] text-faint">
                The keccak256 hash of the exact output bytes. {agreeing.length} of {runs.filter((r) => r.host !== zeroAddress).length} runs reported
                it. The renter paid the price per run for each of the two runs that agreed; each host received that less the protocol fee.
              </p>
            </>
          ) : (
            <p className="text-muted">{failed ? "No result: the runs never agreed." : "No result yet."}</p>
          )}
        </Section>

        <Section title="On-chain record">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
            <Stat label="Chain">
              <span title={chain ? `${chain.name} (${chain.id})` : undefined}>{chain?.name ?? "Unknown"}</span>
            </Stat>
            <Stat label="Contract">
              <Addr address={swarm} explorer={explorer} />
            </Stat>
            <Stat label="Block">
              {decided?.decision ? (
                <ExplorerLink explorer={explorer} path={`block/${decided.decision.blockNumber}`}>
                  {decided.decision.blockNumber.toLocaleString("en-US")}
                </ExplorerLink>
              ) : (
                "—"
              )}
            </Stat>
            <Stat label="Transaction">
              {decided?.decision ? (
                <ExplorerLink explorer={explorer} path={`tx/${decided.decision.transactionHash}`} title={decided.decision.transactionHash}>
                  {shortHash(decided.decision.transactionHash)}
                </ExplorerLink>
              ) : (
                "—"
              )}
            </Stat>
          </dl>
          <p className="mt-4 text-[13px] text-faint">
            {!done && !failed
              ? "The task has not been settled, so there is no transaction to show."
              : decisionLoading
                ? "Looking for the settling event on the chain…"
                : decided?.decision
                  ? `${decided.decision.event === "TaskDone" ? "Recorded by the TaskDone event" : "Recorded by the TaskFailed event"}${
                      decided.decision.at ? ` on ${fmtDate(decided.decision.at)}` : ""
                    }.${explorer ? "" : " This network has no block explorer."}`
                  : decisionError
                    ? "The settling event could not be read from the chain right now."
                    : "The settling event was not found in the blocks searched."}
          </p>
        </Section>

        <Section title="Verify output">
          <p className="max-w-[62ch] text-[14px] text-muted">
            Asks a host that reported the agreed result for the output, hashes it in your browser and compares the hash with the one recorded on
            the chain. A file that does not hash to it is rejected.
          </p>
          {final ? (
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button onClick={verify} disabled={verification.phase === "working" || !client}>
                {verification.phase === "working" ? "Fetching…" : verification.phase === "done" ? "Verify again" : "Verify output"}
              </Button>
              {verified && (
                <Button variant="secondary" onClick={() => download(verified.bytes)}>
                  Download output
                </Button>
              )}
            </div>
          ) : (
            <p className="mt-5 text-[13px] text-faint">There is nothing to verify until two hosts have agreed.</p>
          )}
          {verification.phase === "error" && <p className="mt-4 break-words text-[13px] text-bad">Could not check the output: {verification.message}</p>}
          {verification.phase === "done" && <Outcome check={verification.check} hosts={verification.hosts} />}
        </Section>
      </div>
    </>
  );
}

/** What a run did, in the table's words, with the colour of its index. */
function verdict(
  run: { host: string; commit: string; result: string },
  slot: number,
  final: Hex | null,
  state: number | undefined,
  faulted: Set<string>,
): [Tone, string] {
  if (run.host === zeroAddress) return ["off", slot === 2 && state === TaskState.Done ? "Not needed" : "Not started"];
  if (final && run.result === final) return ["ok", "Agreed"];
  if (run.result !== zeroHash) {
    return state === TaskState.Done ? ["bad", "Outvoted · fault recorded"] : state === TaskState.Failed ? ["bad", "Disagreed"] : ["busy", "Revealed"];
  }
  if (faulted.has(run.host.toLowerCase())) return ["bad", "Missed its reveal"];
  return ["off", run.commit !== zeroHash ? "Committed, not revealed" : "Running"];
}

function Outcome({ check, hosts }: { check: OutputCheck; hosts: number }) {
  if (check.status === "verified") {
    const text = new TextDecoder().decode(check.bytes);
    return (
      <div className="mt-6">
        <Status tone="ok">Matches the chain</Status>
        <p className="mt-2 break-all text-[13px] text-muted">
          {check.bytes.length.toLocaleString("en-US")} bytes from {shortAddr(check.host)} hash to <span className="font-mono">{check.hash}</span>.
        </p>
        <pre className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-[3px] bg-plate px-4 py-3 font-mono text-[13px]">
          {text.slice(0, PREVIEW_CHARS)}
        </pre>
        {text.length > PREVIEW_CHARS && (
          <p className="tnum mt-2 text-[13px] text-faint">Showing the first {PREVIEW_CHARS.toLocaleString("en-US")} characters; the download has all of it.</p>
        )}
      </div>
    );
  }
  if (check.status === "mismatch") {
    return (
      <div className="mt-6">
        <Status tone="bad">Does not match the chain</Status>
        <p className="mt-2 break-all text-[13px] text-muted">
          The output served by {shortAddr(check.host)} hashes to <span className="font-mono">{check.hash}</span>, which is not the result recorded
          on-chain. It is not the output the hosts agreed on, so it is not offered for download.
        </p>
      </div>
    );
  }
  return (
    <div className="mt-6">
      <Status tone="off">Could not be checked</Status>
      <p className="mt-2 text-[13px] text-muted">
        {hosts === 0
          ? "None of the hosts that reported this result has published an address to fetch outputs from."
          : "No host that reported this result answered with the output just now. The receipt above still stands; only the file could not be checked."}
      </p>
    </div>
  );
}

/** An address, short, with the full one on hover and a link to the explorer when the chain has one. */
function Addr({ address, explorer }: { address: string; explorer: string | undefined }) {
  const text = (
    <span className="font-mono text-[13px]" title={address}>
      {shortAddr(address)}
    </span>
  );
  return explorer ? (
    <a href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer" className={linkClass}>
      {text}
    </a>
  ) : (
    text
  );
}

function ExplorerLink({ explorer, path, title, children }: { explorer: string | undefined; path: string; title?: string; children: ReactNode }) {
  return explorer ? (
    <a href={`${explorer}/${path}`} target="_blank" rel="noreferrer" title={title} className={linkClass}>
      {children}
    </a>
  ) : (
    <span title={title}>{children}</span>
  );
}

/** Copies `value` to the clipboard and says so for a moment. */
function Copy({ value, label = "Copy" }: { value: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed"); // the clipboard is blocked outside secure pages
    }
    setTimeout(() => setState("idle"), 1_500);
  }
  return (
    <button type="button" onClick={copy} className="shrink-0 text-[13px] text-muted transition-colors hover:text-steel">
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </button>
  );
}

/** Copies the address of this page, so a receipt can be sent to someone. */
function CopyLink() {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 1_500);
  }
  return (
    <Button variant="secondary" onClick={copy}>
      {state === "copied" ? "Link copied" : state === "failed" ? "Copy failed" : "Copy link"}
    </Button>
  );
}
