import { useQueries, useQuery, keepPreviousData } from "@tanstack/react-query";
import type { ContractFunctionReturnType } from "viem";
import { useChainId, usePublicClient, useReadContract, useReadContracts } from "wagmi";
import {
  anvil,
  erc20Abi,
  gpuModel,
  gridMarketAbi,
  type MachineMetadata,
  parseMetadata,
  stakeRegistryAbi,
  swarmMarketAbi,
} from "@grid/shared";
import { useDeployment } from "../contracts";
import { healthQuery } from "./hooks";
import { type MachineView, machineStatus } from "./machines";

type Address = `0x${string}`;
type Client = NonNullable<ReturnType<typeof usePublicClient>>;

const DAY = 86_400;

// ---------------------------------------------------------------- reading event history

/** On a public chain only this many of the latest blocks are scanned for events (the local chain is read from block 0). */
export const WINDOW_BLOCKS = 2_000_000n;
/** Events are requested in ranges of this many blocks, fewer once a node has shown it will not serve that much. */
export const CHUNK_BLOCKS = 50_000n;
/** A range is never split below this many blocks. */
const MIN_SPLIT = 1_000n;
/** Failed requests one scan may spend on splitting ranges before it gives up and reports the error. */
const MAX_FAILURES = 48;
/** Ranges requested at the same time. */
const PARALLEL = 4;
/** Blocks read again on every refresh, in case the chain's last blocks were replaced. */
const OVERLAP = 32n;

/** The widest range each chain's node has accepted so far. */
const learnedSpan = new Map<number, bigint>();

export const chunkSize = (chainId: number) => learnedSpan.get(chainId) ?? CHUNK_BLOCKS;

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

/** Runs `fn` over `items`, at most `limit` at a time, keeping the order of the results. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * Reads one block range. Nodes differ in how much they will return at once, so a request that fails
 * is retried as two halves; once both halves have gone through, later ranges start that small.
 */
export async function readRange<E>(
  chainId: number,
  from: bigint,
  to: bigint,
  fetchRange: (from: bigint, to: bigint) => Promise<E[]>,
  budget: { failures: number },
): Promise<E[]> {
  const halves = async () => {
    const mid = from + (to - from) / 2n;
    const left = await readRange(chainId, from, mid, fetchRange, budget);
    const right = await readRange(chainId, mid + 1n, to, fetchRange, budget);
    return left.concat(right);
  };
  const width = to - from + 1n;
  // Once the node has shown how much it will serve, wider ranges are cut down before asking.
  if (width > chunkSize(chainId) && to - from >= MIN_SPLIT) return halves();
  try {
    return await fetchRange(from, to);
  } catch (error) {
    if (to - from < MIN_SPLIT || ++budget.failures > MAX_FAILURES) throw error;
    const results = await halves();
    // Both halves went through, so the range itself was too wide for this node: read in smaller pieces from now on.
    learnedSpan.set(chainId, min(chunkSize(chainId), width / 2n));
    return results;
  }
}

type Positioned = { blockNumber: bigint; logIndex: number };
const scanStore = new Map<string, { upTo: bigint; items: Positioned[] }>();

/**
 * Every event `fetchRange` finds from block `from` to the chain's latest block. What was read stays in
 * memory under `key`, so a refresh only reads the blocks that are new, and a scan that fails halfway
 * keeps its progress for the next attempt.
 */
async function scanEvents<E extends Positioned>(
  client: Client,
  key: string,
  from: bigint,
  fetchRange: (from: bigint, to: bigint) => Promise<E[]>,
): Promise<E[]> {
  const chainId = client.chain.id;
  const latest = await client.getBlockNumber();
  const known = scanStore.get(key) as { upTo: bigint; items: E[] } | undefined;
  let next = known ? max(from, known.upTo - OVERLAP + 1n) : from;
  let items = known ? known.items.filter((e) => e.blockNumber < next) : [];
  const budget = { failures: 0 };
  while (next <= latest) {
    const ranges: [bigint, bigint][] = [];
    for (let i = 0; i < PARALLEL && next <= latest; i++) {
      const to = min(next + chunkSize(chainId) - 1n, latest);
      ranges.push([next, to]);
      next = to + 1n;
    }
    const got = await Promise.all(ranges.map(([a, b]) => readRange(chainId, a, b, fetchRange, budget)));
    items = items.concat(got.flat());
    scanStore.set(key, { upTo: ranges[ranges.length - 1][1], items });
  }
  return items;
}

// ---------------------------------------------------------------- the window being read

export type ScanWindow = {
  from: bigint;
  /** Unix time of the block the window starts at. */
  fromTs: number;
  /** True when the window starts at the chain's first block, so it holds all of the chain's history. */
  whole: boolean;
};

/** Where event scanning starts. It is fixed per chain for the life of the page, so scans can be extended instead of repeated. */
export function useScanWindow() {
  const chainId = useChainId();
  const client = usePublicClient({ chainId });
  return useQuery({
    queryKey: ["network-window", chainId],
    enabled: !!client,
    staleTime: Infinity,
    retry: 2,
    queryFn: async (): Promise<ScanWindow> => {
      const latest = await client!.getBlockNumber();
      const from = chainId === anvil.id || latest <= WINDOW_BLOCKS ? 0n : latest - WINDOW_BLOCKS;
      const block = await client!.getBlock({ blockNumber: from });
      return { from, fromTs: Number(block.timestamp), whole: from === 0n };
    },
  });
}

export type Boundaries = {
  /** First block that is 7 days old or younger, and the same for 30 days. */
  week: bigint;
  month: bigint;
  latest: bigint;
  latestTs: number;
};

/** The block at which a look-back period starts, found by bisecting block timestamps. Refreshed every ten minutes. */
export function useBoundaries() {
  const chainId = useChainId();
  const client = usePublicClient({ chainId });
  return useQuery({
    queryKey: ["network-boundaries", chainId, Math.floor(Date.now() / 600_000)],
    enabled: !!client,
    placeholderData: keepPreviousData,
    staleTime: 600_000,
    retry: 1,
    queryFn: async (): Promise<Boundaries> => {
      const latest = await client!.getBlock();
      const [week, month] = await Promise.all(
        [7, 30].map((days) => firstBlockAtOrAfter(client!, latest.timestamp - BigInt(days * DAY), latest.number)),
      );
      return { week, month, latest: latest.number, latestTs: Number(latest.timestamp) };
    },
  });
}

/** The first block whose timestamp is `ts` or later (the latest block when none is). */
async function firstBlockAtOrAfter(client: Client, ts: bigint, latest: bigint): Promise<bigint> {
  let lo = 0n;
  let hi = latest;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const block = await client.getBlock({ blockNumber: mid });
    if (block.timestamp >= ts) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

export type Period = { label: string; from: bigint; whole: boolean };

/**
 * The look-back periods a figure can honestly be given for, when the history that was read spans
 * `spanSeconds` and starts at block `windowFrom`. A window shorter than 7 or 30 days gets one
 * period that is named for what it really covers, instead of a 30-day label on a few days of data.
 */
export function periodsFor(bounds: Boundaries, spanSeconds: number, windowFrom = 0n): Period[] {
  const periods: Period[] = [];
  if (spanSeconds >= 7 * DAY) periods.push({ label: "Last 7 d", from: max(bounds.week, windowFrom), whole: false });
  if (spanSeconds >= 30 * DAY) periods.push({ label: "Last 30 d", from: max(bounds.month, windowFrom), whole: false });
  else periods.push({ label: `Last ${fmtSpan(spanSeconds)}`, from: windowFrom, whole: true });
  return periods;
}

/** 5.8 d, 14 d, 3 h, 40 min; with `long` the units are spelled out: 5.8 days, 3 hours. */
export function fmtSpan(seconds: number, long = false): string {
  const [value, short, one, many]: [number, string, string, string] =
    seconds >= 10 * DAY
      ? [Math.floor(seconds / DAY), "d", "day", "days"]
      : seconds >= DAY
        ? [Math.floor((seconds / DAY) * 10) / 10, "d", "day", "days"]
        : seconds >= 3600
          ? [Math.floor(seconds / 3600), "h", "hour", "hours"]
          : [Math.max(1, Math.floor(seconds / 60)), "min", "minute", "minutes"];
  return long ? `${value} ${value === 1 ? one : many}` : `${value} ${short}`;
}

// ---------------------------------------------------------------- statistics

type Sample = { value: bigint; weight: number };

/** Mean of the values, each counted `weight` times. */
export function weightedMean(samples: Sample[]): bigint | null {
  let total = 0n;
  let weight = 0n;
  for (const s of samples) {
    total += s.value * BigInt(s.weight);
    weight += BigInt(s.weight);
  }
  return weight === 0n ? null : total / weight;
}

/** Median of the values, each counted `weight` times; halfway between the two middle values when they split the weight evenly. */
export function weightedMedian(samples: Sample[]): bigint | null {
  const sorted = samples.filter((s) => s.weight > 0).sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  if (sorted.length === 0) return null;
  const total = sorted.reduce((n, s) => n + s.weight, 0);
  let seen = 0;
  for (let i = 0; i < sorted.length; i++) {
    seen += sorted[i].weight;
    if (seen * 2 === total && i + 1 < sorted.length) return (sorted[i].value + sorted[i + 1].value) / 2n;
    if (seen * 2 > total) return sorted[i].value;
  }
  return sorted[sorted.length - 1].value;
}

// ---------------------------------------------------------------- hosts

/** Listings are read in fixed pages so one oversized call can never blank the page. */
const LISTING_PAGE = 50n;
/** At most this many nodes are health-checked: a flood of listings cannot turn visitors into a request cannon. */
const MAX_HEALTH_CHECKS = 100;

export type MachineFeed = {
  views: MachineView[];
  /** Lower-cased addresses of hosts with at least one machine whose node answered its health check. */
  reachableHosts: Set<string>;
  loading: boolean;
  error: Error | null;
};

/**
 * Every listed machine with its live status, read the way the market page reads it (same calls, so
 * the two share their cached answers).
 */
export function useMachineViews(): MachineFeed {
  const deployment = useDeployment();
  const { data: count, error: countError } = useReadContract({
    abi: gridMarketAbi,
    address: deployment?.GridMarket,
    functionName: "machineCount",
    query: { enabled: !!deployment, refetchInterval: 15_000 },
  });
  const offsets =
    count === undefined
      ? []
      : Array.from({ length: Number((count + LISTING_PAGE - 1n) / LISTING_PAGE) }, (_, i) => BigInt(i) * LISTING_PAGE);
  const { data: pages, error: pageError } = useReadContracts({
    contracts: deployment
      ? offsets.map(
          (offset) =>
            ({ abi: gridMarketAbi, address: deployment.GridMarket, functionName: "getListings", args: [offset, LISTING_PAGE] }) as const,
        )
      : [],
    query: { enabled: !!deployment && offsets.length > 0, refetchInterval: 15_000 },
  });
  const items = (pages ?? []).flatMap((p) => (p.status === "success" ? [...p.result] : []));
  const metas = items.map((item) => parseMetadata(item.machine.metadata));
  const health = useQueries({ queries: metas.map((meta, i) => healthQuery(i < MAX_HEALTH_CHECKS ? meta?.endpoint : undefined)) });
  const views: MachineView[] = items.map((item, i) => ({ item, meta: metas[i], ...machineStatus(item, metas[i], health[i]) }));
  const reachableHosts = new Set(items.filter((_, i) => health[i].isSuccess).map((item) => item.machine.host.toLowerCase()));
  const loading = !!deployment && (count === undefined || (offsets.length > 0 && !pages)) && !countError;
  return { views, reachableHosts, loading, error: countError ?? pageError };
}

// ---------------------------------------------------------------- swarm

export type JobView = ContractFunctionReturnType<typeof swarmMarketAbi, "view", "getJobs">[number];

const JOB_PAGE = 100n;
/** The most jobs read in one go (newest first); a bigger market is summarised from its latest jobs and says so. */
const MAX_JOBS = 5_000n;

/** Every job, newest first, straight from the contract's state, so the totals do not depend on any event window. */
export function useSwarmJobs() {
  const chainId = useChainId();
  const client = usePublicClient({ chainId });
  const swarm = useDeployment()?.SwarmMarket;
  return useQuery({
    queryKey: ["network-jobs", chainId, swarm],
    enabled: !!client && !!swarm,
    refetchInterval: 30_000,
    retry: 1,
    queryFn: async (): Promise<{ posted: bigint; jobs: JobView[]; partial: boolean }> => {
      const posted = await client!.readContract({ address: swarm!, abi: swarmMarketAbi, functionName: "jobCount" });
      const wanted = min(posted, MAX_JOBS);
      const offsets = Array.from({ length: Number((wanted + JOB_PAGE - 1n) / JOB_PAGE) }, (_, i) => BigInt(i) * JOB_PAGE);
      const pages = await mapLimit(offsets, PARALLEL, (offset) =>
        client!.readContract({ address: swarm!, abi: swarmMarketAbi, functionName: "getJobs", args: [offset, JOB_PAGE] }),
      );
      return { posted, jobs: pages.flatMap((page) => [...page]), partial: posted > MAX_JOBS };
    },
  });
}

export type PriceStats = {
  /** Jobs posted in the period. */
  jobs: number;
  /** Runs that were paid for: two for every task that finished. */
  runs: number;
  mean: bigint | null;
  median: bigint | null;
};

export type SwarmSummary = {
  posted: bigint;
  running: number;
  tasksDone: number;
  paid: bigint;
  periods: { label: string; stats: PriceStats }[];
};

/**
 * Totals over all jobs, and the price per run in each period. A job counts towards a period when it
 * was posted in it, and its price is weighted by the runs that were actually paid, so a job nobody
 * has worked on yet does not move the figures.
 */
export function summarizeSwarm(jobs: JobView[], posted: bigint, periods: Period[]): SwarmSummary {
  let tasksDone = 0;
  let paid = 0n;
  let running = 0;
  for (const { job } of jobs) {
    tasksDone += job.done;
    paid += job.paid;
    if (!job.closed && !job.cancelled && job.resolved < job.taskCount) running++;
  }
  return {
    posted,
    running,
    tasksDone,
    paid,
    periods: periods.map((period) => {
      const inPeriod = jobs.filter(({ job }) => job.postedBlock >= period.from);
      const samples = inPeriod.map(({ job }) => ({ value: job.pricePerRun, weight: job.done }));
      return {
        label: period.label,
        stats: {
          jobs: inPeriod.length,
          runs: samples.reduce((n, s) => n + 2 * s.weight, 0),
          mean: weightedMean(samples),
          median: weightedMedian(samples),
        },
      };
    }),
  };
}

// ---------------------------------------------------------------- direct rentals

type RentalEnd = Positioned & { rentalId: bigint; machineId: bigint; paidToHost: bigint; fee: bigint };
export type SettledRental = RentalEnd & { pricePerHour: bigint };

/** Prices are looked up for at most this many of the latest settled rentals. */
const MAX_PRICED = 500;
/** A rental's price is fixed when it starts, so it is read once. */
const rentalPrices = new Map<string, bigint>();

/**
 * Rentals that ended in the scanned window (GridMarket's RentalEnded events), each with the hourly
 * price it was rented at. A rental that cost nothing, ended by its host inside the first minute,
 * says nothing about price and is left out. What a rental cost is what the host received plus the
 * protocol fee that came out of it.
 */
export function useSettledRentals(window: ScanWindow | undefined) {
  const chainId = useChainId();
  const client = usePublicClient({ chainId });
  const market = useDeployment()?.GridMarket;
  return useQuery({
    queryKey: ["network-rentals", chainId, market, window?.from.toString()],
    enabled: !!client && !!market && !!window,
    refetchInterval: 30_000,
    retry: 1,
    queryFn: async (): Promise<{ settled: SettledRental[]; total: number }> => {
      const ended = await scanEvents<RentalEnd>(client!, `rentals:${chainId}:${market}:${window!.from}`, window!.from, async (fromBlock, toBlock) =>
        (await client!.getContractEvents({ address: market!, abi: gridMarketAbi, eventName: "RentalEnded", fromBlock, toBlock })).map((log) => ({
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          rentalId: log.args.rentalId!,
          machineId: log.args.machineId!,
          paidToHost: log.args.paidToHost!,
          fee: log.args.fee!,
        })),
      );
      const paid = ended.filter((e) => e.paidToHost + e.fee > 0n);
      const recent = paid.slice(-MAX_PRICED);
      await mapLimit(
        recent.filter((e) => !rentalPrices.has(`${chainId}:${market}:${e.rentalId}`)),
        8,
        async (e) => {
          try {
            const rental = await client!.readContract({ address: market!, abi: gridMarketAbi, functionName: "getRental", args: [e.rentalId] });
            rentalPrices.set(`${chainId}:${market}:${e.rentalId}`, rental.pricePerHour);
          } catch {
            // this rental is left out of the price figures; the count still includes it
          }
        },
      );
      const settled = recent.flatMap((e) => {
        const pricePerHour = rentalPrices.get(`${chainId}:${market}:${e.rentalId}`);
        return pricePerHour === undefined ? [] : [{ ...e, pricePerHour }];
      });
      return { settled, total: paid.length };
    },
  });
}

export type PriceRow = {
  model: string;
  /** One entry per period, in the order the periods were given. */
  periods: { median: bigint | null; count: number }[];
  /** Settled rentals of this model in all of the scanned window. */
  settled: number;
  /** Median listed price per GPU-hour of machines of this model that are open to rent, and how many there are. */
  listed: bigint | null;
  listedCount: number;
};

const perGpu = (pricePerHour: bigint, meta: MachineMetadata | null) => pricePerHour / BigInt(Math.max(1, meta?.gpuCount ?? 1));

/**
 * The price index: for each GPU model, the median price per GPU-hour that settled rentals paid in each
 * period, how many there were, and what machines of that model are listed at today. The model comes
 * from the machine's listing, which is also how the market groups machines.
 */
export function priceIndex(settled: SettledRental[], views: MachineView[], periods: Period[]): PriceRow[] {
  const metaOf = new Map(views.map((v) => [v.item.id.toString(), v.meta]));
  const rows = new Map<string, { settled: SettledRental[]; listed: bigint[]; prices: Map<SettledRental, bigint> }>();
  const row = (model: string) => {
    let r = rows.get(model);
    if (!r) rows.set(model, (r = { settled: [], listed: [], prices: new Map() }));
    return r;
  };
  for (const rental of settled) {
    const meta = metaOf.get(rental.machineId.toString()) ?? null;
    const r = row(gpuModel(meta));
    r.settled.push(rental);
    r.prices.set(rental, perGpu(rental.pricePerHour, meta));
  }
  for (const v of views) {
    if (v.item.machine.available) row(gpuModel(v.meta)).listed.push(perGpu(v.item.machine.pricePerHour, v.meta));
  }
  const out: PriceRow[] = [...rows].map(([model, r]) => ({
    model,
    periods: periods.map((p) => {
      const inPeriod = r.settled.filter((s) => s.blockNumber >= p.from);
      return { median: weightedMedian(inPeriod.map((s) => ({ value: r.prices.get(s)!, weight: 1 }))), count: inPeriod.length };
    }),
    settled: r.settled.length,
    listed: weightedMedian(r.listed.map((value) => ({ value, weight: 1 }))),
    listedCount: r.listed.length,
  }));
  // Models with settled rentals first, busiest first; a CPU-only or unknown machine goes last.
  const rank = (m: string) => (m === "CPU only" ? 2 : m === "Unknown" ? 3 : 0);
  return out.sort((a, b) => rank(a.model) - rank(b.model) || b.settled - a.settled || a.model.localeCompare(b.model));
}

// ---------------------------------------------------------------- bond

/** Hosts whose bond is read one by one; more than this and the totals say they are a lower bound. */
const MAX_BOND_HOSTS = 500;

export type BondSummary = {
  /** GRID bonded now and GRID in a pending unbond, summed over the hosts found in the scanned window. */
  bonded: bigint;
  unbonding: bigint;
  /** Everything the registry holds, bonded and unbonding, or null if the token could not be read. */
  held: bigint | null;
  /** GRID burned by slashing within the scanned window. */
  burned: bigint;
  /** Hosts with a bond, and hosts that ever bonded in the window. */
  bondedHosts: number;
  hosts: number;
  /** Whether the hosts found account for all the GRID the registry holds. */
  complete: boolean;
};

/**
 * Bonds from StakeRegistry. Which hosts ever bonded comes from Bonded events; what each has bonded
 * now is read from the registry itself, which already nets out unbonds and slashes. The registry's
 * GRID balance is the check: if the hosts found do not add up to it, some bonded before the window.
 */
export function useBonds(window: ScanWindow | undefined) {
  const chainId = useChainId();
  const client = usePublicClient({ chainId });
  const deployment = useDeployment();
  const registry = deployment?.StakeRegistry;
  return useQuery({
    queryKey: ["network-bonds", chainId, registry, window?.from.toString()],
    enabled: !!client && !!registry && !!window,
    refetchInterval: 30_000,
    retry: 1,
    queryFn: async (): Promise<BondSummary> => {
      const base = { address: registry!, abi: stakeRegistryAbi } as const;
      const from = window!.from;
      const [bondedEvents, slashedEvents] = await Promise.all([
        scanEvents<Positioned & { host: Address }>(client!, `bonded:${chainId}:${registry}:${from}`, from, async (fromBlock, toBlock) =>
          (await client!.getContractEvents({ ...base, eventName: "Bonded", fromBlock, toBlock })).map((log) => ({
            blockNumber: log.blockNumber,
            logIndex: log.logIndex,
            host: log.args.host!,
          })),
        ),
        scanEvents<Positioned & { amount: bigint }>(client!, `slashed:${chainId}:${registry}:${from}`, from, async (fromBlock, toBlock) =>
          (await client!.getContractEvents({ ...base, eventName: "Slashed", fromBlock, toBlock })).map((log) => ({
            blockNumber: log.blockNumber,
            logIndex: log.logIndex,
            amount: log.args.amount!,
          })),
        ),
      ]);

      const found = [...new Map(bondedEvents.map((e) => [e.host.toLowerCase(), e.host])).values()];
      const hosts = found.slice(0, MAX_BOND_HOSTS);
      const states = await mapLimit(hosts, 8, async (host) => {
        const [bonded, unbond] = await Promise.all([
          client!.readContract({ ...base, functionName: "bonded", args: [host] }),
          client!.readContract({ ...base, functionName: "unbonds", args: [host] }),
        ]);
        return { bonded, unbonding: unbond[0] };
      });
      const held = await client!
        .readContract({ address: deployment!.GRID, abi: erc20Abi, functionName: "balanceOf", args: [registry!] })
        .catch(() => null);

      const bonded = states.reduce((n, s) => n + s.bonded, 0n);
      const unbonding = states.reduce((n, s) => n + s.unbonding, 0n);
      return {
        bonded,
        unbonding,
        held,
        burned: slashedEvents.reduce((n, e) => n + e.amount, 0n),
        bondedHosts: states.filter((s) => s.bonded > 0n).length,
        hosts: found.length,
        complete: held !== null && found.length <= MAX_BOND_HOSTS && bonded + unbonding >= held,
      };
    },
  });
}
