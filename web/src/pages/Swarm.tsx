import { useState } from "react";
import { parseEther, parseEventLogs, toBytes } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { encodeManifest, MAX_MANIFEST_BYTES, SWARM_RUNS, type SwarmManifest, swarmMarketAbi } from "@grid/shared";
import { Button, ErrorText, Input, linkClass, Status, type Tone } from "../components/ui";
import { useDeployment } from "../contracts";
import { fmtEth } from "../lib/format";
import { useManifest } from "../lib/swarm";
import { useTx } from "../lib/useTx";
import { Link, navigate } from "../router";

const EXAMPLE = {
  image: "python:3.12-slim",
  command: `python -c "import sys; print(sum(int(n) for n in sys.stdin.read().split()))"`,
  inputs: ["1 2 3", "4 5 6", "7 8 9", "10 11 12", "13 14 15", "16 17 18", "19 20 21", "22 23 24"].join("\n"),
};

export function Swarm() {
  return (
    <>
      <PostJob />
      <Jobs />
    </>
  );
}

const label = "engraved pt-2 text-faint";

function PostJob() {
  const deployment = useDeployment();
  const tx = useTx();
  const [image, setImage] = useState("");
  const [command, setCommand] = useState("");
  const [inputs, setInputs] = useState("");
  const [price, setPrice] = useState("0.0001");
  const [lease, setLease] = useState("10");
  const [gpu, setGpu] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const tasks = inputs.split("\n").filter((line) => line.trim() !== "");
  let priceWei = 0n;
  try {
    priceWei = parseEther(price || "0");
  } catch {
    priceWei = 0n;
  }
  const deposit = priceWei * BigInt(tasks.length) * BigInt(SWARM_RUNS);
  const manifest: SwarmManifest = { v: 1, image: image.trim(), command: command.trim(), gpu, tasks };
  const manifestBytes = toBytes(JSON.stringify(manifest)).length;
  const leaseMinutes = Math.min(1440, Math.max(1, Math.floor(Number(lease) || 0)));

  async function post() {
    setProblem(null);
    const swarm = deployment?.SwarmMarket;
    if (!swarm) return setProblem("Swarm jobs are not available on this network.");
    if (!manifest.image || !manifest.command) return setProblem("Give the job a container image and a command.");
    if (tasks.length === 0) return setProblem("Add at least one input, one per line.");
    if (priceWei === 0n) return setProblem("Set a price per run above zero.");
    if (manifestBytes > MAX_MANIFEST_BYTES) {
      return setProblem(`The job description is ${Math.ceil(manifestBytes / 1024)} KB; the limit is 64 KB.`);
    }
    const receipts = await tx.run("Posting…", [
      () =>
        tx.write({
          abi: swarmMarketAbi,
          address: swarm,
          functionName: "postJob",
          args: [priceWei, tasks.length, leaseMinutes * 60, encodeManifest(manifest)],
          value: deposit,
        }),
    ]);
    const [posted] = receipts
      ? parseEventLogs({ abi: swarmMarketAbi, eventName: "JobPosted", logs: receipts.flatMap((r) => r.logs) })
      : [];
    if (posted) navigate(`/jobs/${posted.args.jobId}`);
  }

  return (
    <section className="mt-12">
      <div className="flex items-end justify-between gap-4 border-b border-rule pb-2">
        <h2 className="engraved text-ink">Post a job</h2>
        <button
          type="button"
          className="text-[13px] text-muted transition-colors hover:text-steel"
          onClick={() => {
            setImage(EXAMPLE.image);
            setCommand(EXAMPLE.command);
            setInputs(EXAMPLE.inputs);
          }}
        >
          Fill in an example
        </button>
      </div>

      <div className="mt-6 grid gap-x-8 gap-y-5 sm:grid-cols-[8.5rem_minmax(0,1fr)]">
        <label htmlFor="job-image" className={label}>
          Container
        </label>
        <Input
          id="job-image"
          value={image}
          onChange={(e) => setImage(e.target.value)}
          placeholder="python:3.12-slim"
          className="w-full max-w-md"
        />

        <label htmlFor="job-command" className={label}>
          Command
        </label>
        <div>
          <Input
            id="job-command"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="python main.py"
            className="w-full max-w-2xl"
          />
          <p className="mt-2 text-[13px] text-faint">Runs with sh -c. Each task's input arrives on stdin; its stdout is the result.</p>
        </div>

        <label htmlFor="job-inputs" className={label}>
          Inputs
        </label>
        <div>
          <textarea
            id="job-inputs"
            value={inputs}
            onChange={(e) => setInputs(e.target.value)}
            rows={7}
            spellCheck={false}
            placeholder={"One task per line"}
            className="tnum block w-full max-w-2xl resize-y rounded-[3px] border border-line bg-dial px-2.5 py-2 font-mono text-[13px] leading-relaxed outline-none transition-colors focus:border-steel"
          />
          <p className="tnum mt-2 text-[13px] text-faint">
            {tasks.length.toLocaleString("en-US")} task{tasks.length === 1 ? "" : "s"}
          </p>
        </div>

        <span className={label}>Terms</span>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-[13px] text-muted">
          <label className="flex items-center gap-2">
            <Input value={price} onChange={(e) => setPrice(e.target.value)} className="w-24" aria-label="Price per run in ETH" />
            ETH per run
          </label>
          <label className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={1440}
              value={lease}
              onChange={(e) => setLease(e.target.value)}
              className="w-16"
              aria-label="Lease in minutes"
            />
            min to finish a task
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={gpu} onChange={(e) => setGpu(e.target.checked)} className="accent-steel" />
            Needs a GPU
          </label>
        </div>
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-5">
        <p className="tnum max-w-[60ch] text-[13px] text-muted">
          {tasks.length.toLocaleString("en-US")} × {SWARM_RUNS} runs × {fmtEth(priceWei)} ETH ={" "}
          <span className="font-mono text-ink">{fmtEth(deposit)} ETH</span> held by the contract. Each task runs twice, the
          third run is kept for a tie-break, and whatever is not used comes back to you.
        </p>
        <Button onClick={post} disabled={!!tx.pending}>
          {tx.pending ?? "Post job"}
        </Button>
      </div>
      <p className="mt-3 text-[13px] text-faint">
        Outputs from two hosts are compared byte for byte, so the command must give the same output for the same input.
        The job description is published on-chain; keep secrets out of it.
      </p>
      <ErrorText className="mt-3">{problem ?? tx.error}</ErrorText>
    </section>
  );
}

const JOB_COLS =
  "sm:grid sm:grid-cols-[4.5rem_minmax(0,1.6fr)_minmax(0,1fr)_7rem_6rem] sm:items-center sm:gap-6";

function Jobs() {
  const deployment = useDeployment();
  const swarm = deployment?.SwarmMarket;
  const { address } = useAccount();
  const { data: jobs, isLoading } = useReadContract({
    abi: swarmMarketAbi,
    address: swarm,
    functionName: "getJobs",
    args: [0n, 25n],
    query: { enabled: !!swarm, refetchInterval: 5_000 },
  });
  const list = jobs ?? [];

  return (
    <section className="mt-16">
      <div className="flex items-end justify-between gap-4 border-b border-rule pb-2">
        <h2 className="engraved text-ink">
          Jobs{!isLoading && <span className="tnum ml-2 text-faint">{String(list.length).padStart(2, "0")}</span>}
        </h2>
      </div>
      <div className={`engraved hidden border-b border-line py-2.5 text-faint ${JOB_COLS}`}>
        <span>Job</span>
        <span>Container</span>
        <span>Progress</span>
        <span>Status</span>
        <span className="text-right">ETH / run</span>
      </div>
      {isLoading && swarm ? (
        <p className="border-b border-line py-8 text-muted">Reading jobs…</p>
      ) : list.length === 0 ? (
        <p className="border-b border-line py-8 text-muted">No jobs have been posted yet.</p>
      ) : (
        list.map(({ id, job }) => {
          const mine = !!address && address.toLowerCase() === job.renter.toLowerCase();
          const share = job.taskCount === 0 ? 0 : job.resolved / job.taskCount;
          const [tone, state]: [Tone, string] = job.closed
            ? ["off", "Closed"]
            : job.cancelled
              ? ["off", "Cancelled"]
              : job.resolved === job.taskCount
                ? ["ok", "Finished"]
                : ["busy", "Running"];
          return (
            <Link
              key={id.toString()}
              href={`/jobs/${id}`}
              className={`flex flex-col gap-1 border-b border-line py-4 transition-colors hover:bg-plate ${JOB_COLS}`}
            >
              <span className="tnum font-medium">
                {id.toString()}
                {mine && <span className="ml-2 font-mono text-[12px] font-normal text-faint">yours</span>}
              </span>
              <JobImage swarm={swarm!} id={id} postedBlock={job.postedBlock} />
              <span className="flex items-center gap-3">
                <span className="relative h-[3px] w-20 bg-line" aria-hidden="true">
                  <span className="absolute inset-y-0 left-0 bg-steel" style={{ width: `${share * 100}%` }} />
                </span>
                <span className="tnum font-mono text-[13px] text-muted">
                  {job.done}/{job.taskCount}
                </span>
              </span>
              <Status tone={tone}>{state}</Status>
              <span className="tnum font-mono sm:text-right">{fmtEth(job.pricePerRun)}</span>
            </Link>
          );
        })
      )}
      <p className="mt-4 text-[13px] text-faint">
        Hosts pick up tasks whenever their machines are idle. Run a node to work for the swarm:{" "}
        <Link href="/host" className={linkClass}>
          Host
        </Link>
        .
      </p>
    </section>
  );
}

function JobImage({ swarm, id, postedBlock }: { swarm: `0x${string}`; id: bigint; postedBlock: bigint }) {
  const { data: manifest } = useManifest(swarm, id, postedBlock);
  return <span className="truncate font-mono text-[13px]">{manifest?.image ?? "—"}</span>;
}

