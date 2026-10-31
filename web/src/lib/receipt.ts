import { useQuery } from "@tanstack/react-query";
import { useChainId, usePublicClient } from "wagmi";
import { swarmMarketAbi } from "@grid/shared";
import { chunkSize, readRange } from "./network";

type Address = `0x${string}`;
type Hex = `0x${string}`;

/** SwarmMarket.TaskState. */
export const TaskState = { Open: 0, Done: 1, Failed: 2 } as const;

/** Ranges requested at the same time while looking for the deciding event. */
const PARALLEL = 3;

export type Decision = {
  /** TaskDone when two runs agreed, TaskFailed when all three disagreed. */
  event: "TaskDone" | "TaskFailed";
  blockNumber: bigint;
  transactionHash: Hex;
  /** Unix time of the block, or null if it could not be read. */
  at: number | null;
};

export type Fault = { host: Address; result: Hex };

/**
 * The event that decided a task, and the faults recorded against its hosts. The contract keeps the
 * task's runs but not the transaction that settled it, so this looks for the event, from the block
 * the job was posted in onwards: a task is usually settled soon after its job appears, and the
 * search stops at the first block range that holds it.
 */
export function useDecision(swarm: Address | undefined, jobId: bigint, task: number, state: number | undefined, postedBlock: bigint | undefined) {
  const chainId = useChainId();
  const client = usePublicClient({ chainId });
  const decided = state === TaskState.Done || state === TaskState.Failed;
  return useQuery({
    queryKey: ["receipt-decision", chainId, swarm, jobId.toString(), task, state],
    enabled: !!client && !!swarm && postedBlock !== undefined && decided,
    staleTime: Infinity,
    retry: 1,
    queryFn: async (): Promise<{ decision: Decision | null; faults: Fault[] }> => {
      const event = state === TaskState.Done ? "TaskDone" : "TaskFailed";
      const base = { address: swarm!, abi: swarmMarketAbi, args: { jobId, task } } as const;
      const latest = await client!.getBlockNumber();
      const budget = { failures: 0 };
      const faults: Fault[] = [];
      let found: { blockNumber: bigint; transactionHash: Hex } | null = null;

      for (let next = postedBlock!; next <= latest && !found; ) {
        const ranges: [bigint, bigint][] = [];
        for (let i = 0; i < PARALLEL && next <= latest; i++) {
          const to = next + chunkSize(chainId) - 1n < latest ? next + chunkSize(chainId) - 1n : latest;
          ranges.push([next, to]);
          next = to + 1n;
        }
        const got = await Promise.all(
          ranges.map(async ([fromBlock, toBlock]) => {
            const [decisions, faulted] = await Promise.all([
              readRange(chainId, fromBlock, toBlock, async (a, b) =>
                (await client!.getContractEvents({ ...base, eventName: event, fromBlock: a, toBlock: b })).map((log) => ({
                  blockNumber: log.blockNumber,
                  transactionHash: log.transactionHash,
                })),
              budget),
              readRange(chainId, fromBlock, toBlock, async (a, b) =>
                (await client!.getContractEvents({ ...base, eventName: "Fault", fromBlock: a, toBlock: b })).map((log) => ({
                  host: log.args.host!,
                  result: log.args.result!,
                })),
              budget),
            ]);
            return { decisions, faulted };
          }),
        );
        for (const r of got) {
          faults.push(...r.faulted);
          found ??= r.decisions[0] ?? null;
        }
      }
      if (!found) return { decision: null, faults };

      let at: number | null = null;
      try {
        at = Number((await client!.getBlock({ blockNumber: found.blockNumber })).timestamp);
      } catch {
        // the date is only a nicety; the block number still identifies the event
      }
      return { decision: { event, blockNumber: found.blockNumber, transactionHash: found.transactionHash, at }, faults };
    },
  });
}
