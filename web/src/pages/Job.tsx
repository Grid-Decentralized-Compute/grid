import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { keccak256, toBytes } from "viem";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { resultUrl, type SwarmManifest, swarmMarketAbi, TaskStatus } from "@grid/shared";
import { Button, ErrorText, Stat, Status, type Tone } from "../components/ui";
import { useDeployment } from "../contracts";
import { fmtEth, shortAddr } from "../lib/format";
import { endpointBlocked, useNow } from "../lib/hooks";
import { type JobActivity, useJobActivity, useManifest } from "../lib/swarm";
import { useTx } from "../lib/useTx";
import { Link } from "../router";

/** Tasks drawn on the field; bigger jobs show their first tasks and say so. */
const SHOWN = 2_000;
const STATUS_PAGE = 500;

const statusLook: Record<number, { label: string; cell: string }> = {
  [TaskStatus.Waiting]: { label: "Waiting", cell: "border border-line" },
  [TaskStatus.Running]: { label: "Running", cell: "border border-steel-edge bg-steel-faint" },
  [TaskStatus.Partial]: { label: "One result in", cell: "bg-steel-soft" },
  [TaskStatus.Disputed]: { label: "Disputed", cell: "bg-gold" },
  [TaskStatus.Done]: { label: "Done", cell: "bg-steel" },
  [TaskStatus.Failed]: { label: "Failed", cell: "bg-bad" },
};

type Address = `0x${string}`;

export function JobPage({ id }: { id: bigint }) {
  const deployment = useDeployment();
  const swarm = deployment?.SwarmMarket;
  const { address } = useAccount();
  const now = useNow(5_000);
  const tx = useTx();
  const [selected, setSelected] = useState<number | null>(null);

  const { data: job, error: jobError } = useReadContract({
    abi: swarmMarketAbi,
    address: swarm,
    functionName: "getJob",
    args: [id],
    query: { enabled: !!swarm, refetchInterval: 3_000 },
  });
  const live = !!job && !job.closed && job.resolved < job.taskCount;
  const { data: manifest } = useManifest(swarm, id, job?.postedBlock);
  const { data: activity } = useJobActivity(swarm, id, job?.postedBlock, live, job?.resolved ?? 0);
  const { data: refund } = useReadContract({
    abi: swarmMarketAbi,
    address: swarm,
    functionName: "balances",
    args: [address!],
    query: { enabled: !!swarm && !!address, refetchInterval: 5_000 },
  });

  const shown = Math.min(job?.taskCount ?? 0, SHOWN);
  const { data: pages } = useReadContracts({
    contracts:
      swarm && job
        ? Array.from({ length: Math.ceil(shown / STATUS_PAGE) }, (_, i) => ({
            abi: swarmMarketAbi,
            address: swarm,
            functionName: "taskStatuses" as const,
            args: [id, i * STATUS_PAGE, Math.min(STATUS_PAGE, shown - i * STATUS_PAGE)] as const,
          }))
        : [],
    query: { enabled: !!swarm && !!job, refetchInterval: live ? 2_500 : false },
  });
  const statuses: number[] = (pages ?? []).flatMap((p) => (p.status === "success" ? [...(p.result as number[])] : []));

  if (!swarm || jobError) {
    return (
      <p className="text-muted">
        There is no job {id.toString()} on this network.{" "}
        <Link href="/swarm" className="text-steel underline underline-offset-[3px]">
          Back to the swarm
        </Link>
      </p>
    );
  }
  if (!job) return <p className="text-muted">Reading job {id.toString()}…</p>;

  const mine = !!address && address.toLowerCase() === job.renter.toLowerCase();
  const counts = statuses.reduce<Record<number, number>>((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {});
  const finished = job.resolved === job.taskCount;
  const closable = !job.closed && (finished || (job.cancelled && now > Number(job.lastLeaseEnd)));
  const [tone, state]: [Tone, string] = job.closed
    ? ["off", "Closed"]
    : job.cancelled
      ? ["off", "Cancelled"]
      : finished
        ? ["ok", "Finished"]
        : ["busy", "Running"];

  const cancel = () =>
    tx.run("Cancelling…", [() => tx.write({ abi: swarmMarketAbi, address: swarm, functionName: "cancelJob", args: [id] })]);
  const close = () =>
    tx.run("Closing…", [() => tx.write({ abi: swarmMarketAbi, address: swarm, functionName: "closeJob", args: [id] })]);
  const withdraw = () =>
    tx.run("Withdrawing…", [() => tx.write({ abi: swarmMarketAbi, address: swarm, functionName: "withdraw" })]);

  return (
    <>
      <Link href="/swarm" className="text-[13px] text-muted transition-colors hover:text-steel">
        ← Swarm
      </Link>
      <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
        <h1 className="font-serif text-[34px] font-light leading-[1.1] tracking-[-0.01em]">Job {id.toString()}</h1>
        <Status tone={tone}>{state}</Status>
      </div>
      {manifest && (
        <p className="mt-3 truncate font-mono text-[13px] text-muted" title={`${manifest.image} · ${manifest.command}`}>
          {manifest.image}
          <span className="mx-2 text-line">/</span>
          {manifest.command}
        </p>
      )}

      <dl className="mt-10 grid grid-cols-2 gap-x-6 gap-y-5 border-y border-line py-5 sm:grid-cols-6">
        <Stat label="Tasks">{job.taskCount.toLocaleString("en-US")}</Stat>
        <Stat label="Done">{job.done.toLocaleString("en-US")}</Stat>
        <Stat label="Disputed">{(counts[TaskStatus.Disputed] ?? 0).toLocaleString("en-US")}</Stat>
        <Stat label="Failed">{(job.resolved - job.done).toLocaleString("en-US")}</Stat>
        <Stat label="Hosts">{activity ? activity.hosts.length : "…"}</Stat>
        <Stat label="Paid out">{fmtEth(job.paid)} ETH</Stat>
      </dl>

      <section className="mt-10">
        <div className="flex flex-wrap gap-[3px]" role="grid" aria-label="Tasks">
          {Array.from({ length: shown }, (_, t) => {
            const s = statuses[t] ?? TaskStatus.Waiting;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setSelected(selected === t ? null : t)}
                title={`Task ${t} · ${statusLook[s].label}`}
                aria-label={`Task ${t}, ${statusLook[s].label}`}
                className={`size-[11px] rounded-[2px] transition-colors duration-500 ${statusLook[s].cell} ${
                  selected === t ? "outline outline-[1.5px] outline-offset-[1.5px] outline-ink" : ""
                }`}
              />
            );
          })}
        </div>
        {job.taskCount > SHOWN && (
          <p className="tnum mt-3 text-[13px] text-faint">
            Showing the first {SHOWN.toLocaleString("en-US")} of {job.taskCount.toLocaleString("en-US")} tasks.
          </p>
        )}
        <div className="engraved mt-5 flex flex-wrap gap-x-6 gap-y-2 text-faint">
          {Object.values(statusLook).map((look) => (
            <span key={look.label} className="flex items-center gap-2">
              <span className={`size-[9px] rounded-[2px] ${look.cell}`} aria-hidden="true" />
              {look.label}
            </span>
          ))}
        </div>
      </section>

      {selected !== null && (
        <TaskPanel
          swarm={swarm}
          jobId={id}
          task={selected}
          status={statuses[selected] ?? TaskStatus.Waiting}
          manifest={manifest ?? null}
          activity={activity}
        />
      )}

      {(mine || (refund !== undefined && refund > 0n)) && (
        <section className="mt-14">
          <div className="border-b border-rule pb-2">
            <h2 className="engraved text-ink">Your job</h2>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            {mine && done(job) && activity && (
              <DownloadResults swarm={swarm} jobId={id} manifest={manifest ?? null} activity={activity} />
            )}
            {mine && !job.cancelled && !job.closed && !finished && (
              <Button variant="danger" onClick={cancel} disabled={!!tx.pending}>
                {tx.pending === "Cancelling…" ? tx.pending : "Cancel job"}
              </Button>
            )}
            {mine && closable && (
              <Button onClick={close} disabled={!!tx.pending}>
                {tx.pending === "Closing…" ? tx.pending : `Close and refund ${fmtEth(job.deposit - job.paid)} ETH`}
              </Button>
            )}
            {refund !== undefined && refund > 0n && (
              <Button onClick={withdraw} disabled={!!tx.pending}>
                {tx.pending === "Withdrawing…" ? tx.pending : `Withdraw ${fmtEth(refund)} ETH`}
              </Button>
            )}
          </div>
          <p className="mt-3 text-[13px] text-faint">
            {job.cancelled && !job.closed && !closable
              ? "Cancelled. Runs already leased can still finish; the job can be closed once the last lease ends."
              : "Closing returns every unused run to your balance on the contract, ready to withdraw."}
          </p>
          <ErrorText className="mt-3">{tx.error}</ErrorText>
        </section>
      )}
    </>
  );
}

const done = (job: { done: number }) => job.done > 0;

function TaskPanel({
  swarm,
  jobId,
  task,
  status,
  manifest,
  activity,
}: {
  swarm: Address;
  jobId: bigint;
  task: number;
  status: number;
  manifest: SwarmManifest | null;
  activity: JobActivity | undefined;
}) {
  const agreed = activity?.agreed.get(task);
  const runs = activity?.submitted.get(task) ?? [];
  const faulted = new Set((activity?.faults.get(task) ?? []).map((h) => h.toLowerCase()));
  const output = useVerifiedOutput(swarm, jobId, task, agreed, runs, activity);

  return (
    <section className="mt-10 rounded-[3px] bg-plate px-5 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="engraved text-ink">Task {task}</h2>
        <span className="text-[13px] text-muted">{statusLook[status].label}</span>
      </div>
      {manifest && (
        <>
          <p className="engraved mt-5 text-faint">Input</p>
          <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[13px]">
            {manifest.tasks[task] ?? ""}
          </pre>
        </>
      )}
      <p className="engraved mt-5 text-faint">Runs</p>
      {runs.length === 0 ? (
        <p className="mt-1.5 text-[13px] text-muted">No results yet.</p>
      ) : (
        <ul className="mt-1.5 space-y-1 font-mono text-[13px]">
          {runs.map((r) => (
            <li key={r.host + r.result} className="flex flex-wrap gap-x-4">
              <span>{shortAddr(r.host)}</span>
              <span className="text-faint">{r.result.slice(0, 12)}…</span>
              <span
                className={
                  faulted.has(r.host.toLowerCase()) ? "text-bad" : agreed === r.result ? "text-steel" : "text-muted"
                }
              >
                {faulted.has(r.host.toLowerCase()) ? "outvoted" : agreed === r.result ? "agreed" : "waiting for a match"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {agreed && (
        <>
          <p className="engraved mt-5 text-faint">Output</p>
          {output.isLoading ? (
            <p className="mt-1.5 text-[13px] text-muted">Fetching from a host…</p>
          ) : output.data ? (
            <>
              <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[13px]">
                {output.data.text}
              </pre>
              <p className="mt-2 text-[13px] text-steel">
                Fetched from {shortAddr(output.data.host)} and matched against the hash on-chain.
              </p>
            </>
          ) : (
            <p className="mt-1.5 text-[13px] text-muted">No host serving this output could be reached.</p>
          )}
        </>
      )}
    </section>
  );
}

/** Fetches a finished task's output from any agreeing host and keeps it only if its hash matches. */
function useVerifiedOutput(
  swarm: Address,
  jobId: bigint,
  task: number,
  agreed: `0x${string}` | undefined,
  runs: { host: Address; result: `0x${string}` }[],
  activity: JobActivity | undefined,
) {
  return useQuery({
    queryKey: ["output", swarm, jobId.toString(), task, agreed],
    enabled: !!agreed && !!activity,
    staleTime: Infinity,
    retry: false,
    queryFn: () => fetchVerified(swarm, jobId, task, agreed!, runs, activity!),
  });
}

async function fetchVerified(
  swarm: Address,
  jobId: bigint,
  task: number,
  agreed: `0x${string}`,
  runs: { host: Address; result: `0x${string}` }[],
  activity: JobActivity,
): Promise<{ host: Address; text: string } | null> {
  for (const run of runs.filter((r) => r.result === agreed)) {
    const endpoint = activity.endpoints.get(run.host);
    if (!endpoint || endpointBlocked(endpoint)) continue;
    try {
      const res = await fetch(resultUrl(endpoint, swarm, jobId, task), { signal: AbortSignal.timeout(6_000) });
      if (!res.ok) continue;
      const text = await res.text();
      if (keccak256(toBytes(text)) === agreed) return { host: run.host, text };
    } catch {
      // try the next host that agreed
    }
  }
  return null;
}

function DownloadResults({
  swarm,
  jobId,
  manifest,
  activity,
}: {
  swarm: Address;
  jobId: bigint;
  manifest: SwarmManifest | null;
  activity: JobActivity;
}) {
  const [progress, setProgress] = useState<string | null>(null);

  async function download() {
    const tasks = [...activity.agreed.keys()].sort((a, b) => a - b);
    const out: { task: number; input: string | null; output: string | null; verified: boolean }[] = [];
    for (const [i, task] of tasks.entries()) {
      setProgress(`${i + 1} / ${tasks.length}`);
      const got = await fetchVerified(swarm, jobId, task, activity.agreed.get(task)!, activity.submitted.get(task) ?? [], activity);
      out.push({ task, input: manifest?.tasks[task] ?? null, output: got?.text ?? null, verified: !!got });
    }
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `grid-job-${jobId}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setProgress(null);
  }

  return (
    <Button variant="secondary" onClick={download} disabled={progress !== null}>
      {progress ? `Fetching ${progress}` : "Download results"}
    </Button>
  );
}
