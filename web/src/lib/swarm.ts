import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { parseManifest, swarmMarketAbi, type SwarmManifest } from "@grid/shared";

type Address = `0x${string}`;

/** A job's manifest, read from its JobPosted event (the contract only stores the hash). */
export function useManifest(swarm: Address | undefined, jobId: bigint, postedBlock: bigint | undefined) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["manifest", swarm, jobId.toString()],
    enabled: !!client && !!swarm && postedBlock !== undefined,
    staleTime: Infinity,
    queryFn: async (): Promise<SwarmManifest | null> => {
      const [event] = await client!.getContractEvents({
        address: swarm!,
        abi: swarmMarketAbi,
        eventName: "JobPosted",
        args: { jobId },
        fromBlock: postedBlock!,
        toBlock: postedBlock!,
      });
      return event?.args.manifest ? parseManifest(event.args.manifest) : null;
    },
  });
}

export type JobActivity = {
  /** Every host that has taken a run of this job. */
  hosts: Address[];
  /** Results submitted per task, in order. */
  submitted: Map<number, { host: Address; result: `0x${string}` }[]>;
  /** The agreed result of each finished task. */
  agreed: Map<number, `0x${string}`>;
  /** Hosts outvoted on a task. */
  faults: Map<number, Address[]>;
  /** Public endpoint of each host that serves outputs. */
  endpoints: Map<Address, string>;
};

/** Who worked on a job and what they returned, rebuilt from the contract's events. */
export function useJobActivity(
  swarm: Address | undefined,
  jobId: bigint,
  postedBlock: bigint | undefined,
  live: boolean,
  /** Changes whenever the job moves on (e.g. tasks resolved), so a finished job is read once more. */
  version: number,
) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["job-activity", swarm, jobId.toString(), version],
    enabled: !!client && !!swarm && postedBlock !== undefined,
    refetchInterval: live ? 4_000 : false,
    placeholderData: (previous) => previous,
    queryFn: async (): Promise<JobActivity> => {
      const base = { address: swarm!, abi: swarmMarketAbi, args: { jobId }, fromBlock: postedBlock! } as const;
      const [claimed, submitted, done, faults] = await Promise.all([
        client!.getContractEvents({ ...base, eventName: "Claimed" }),
        client!.getContractEvents({ ...base, eventName: "Submitted" }),
        client!.getContractEvents({ ...base, eventName: "TaskDone" }),
        client!.getContractEvents({ ...base, eventName: "Fault" }),
      ]);

      const hosts = [...new Set(claimed.map((e) => e.args.host!))];
      const bySubmit = new Map<number, { host: Address; result: `0x${string}` }[]>();
      for (const e of submitted) {
        const list = bySubmit.get(e.args.task!) ?? [];
        list.push({ host: e.args.host!, result: e.args.result! });
        bySubmit.set(e.args.task!, list);
      }
      const agreed = new Map(done.map((e) => [e.args.task!, e.args.result!] as const));
      const byFault = new Map<number, Address[]>();
      for (const e of faults) byFault.set(e.args.task!, [...(byFault.get(e.args.task!) ?? []), e.args.host!]);

      const endpoints = new Map<Address, string>();
      await Promise.all(
        hosts.map(async (host) => {
          const url = await client!.readContract({
            address: swarm!,
            abi: swarmMarketAbi,
            functionName: "workerEndpoint",
            args: [host],
          });
          if (url) endpoints.set(host, url);
        }),
      );
      return { hosts, submitted: bySubmit, agreed, faults: byFault, endpoints };
    },
  });
}
