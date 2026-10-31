import { Component, type ReactNode } from "react";
import { useReadContract } from "wagmi";
import { HEARTBEAT_TTL_SECONDS, stakeRegistryAbi } from "@grid/shared";
import { Page, Section, Stat } from "../components/ui";
import { useDeployment } from "../contracts";
import { fmtEth, fmtGrid, shortError } from "../lib/format";
import { usePeers } from "../lib/hooks";
import { gpuGroups } from "../lib/machines";
import {
  type Boundaries,
  fmtSpan,
  type MachineFeed,
  periodsFor,
  priceIndex,
  type PriceRow,
  type PriceStats,
  summarizeSwarm,
  useBonds,
  useBoundaries,
  useMachineViews,
  useScanWindow,
  useSettledRentals,
  useSwarmJobs,
  WINDOW_BLOCKS,
} from "../lib/network";

type Query<T> = { data: T | undefined; error: Error | null; isLoading: boolean };

const count = (n: number | bigint) => n.toLocaleString("en-US");
/** GRID with thousands separators: 1,250,000.5 */
const grid = (wei: bigint) => fmtGrid(wei).replace(/^\d+/, (int) => int.replace(/\B(?=(\d{3})+(?!\d))/g, ","));
const price = (wei: bigint | null) => (wei === null ? "—" : fmtEth(wei, 6));

const HEAD = "engraved gap-x-3 border-b border-line py-2.5 text-faint sm:gap-x-6";
const ROW = "gap-x-3 border-b border-line py-3 sm:gap-x-6";

/**
 * The network at a glance, from the chain and from the host nodes: who is listed and online, what swarm
 * work has been paid, what direct rentals settle at and how much GRID is bonded. Each section reads
 * for itself, so one that cannot be read says so and the others carry on.
 */
export function NetworkPage() {
  const deployment = useDeployment();
  const machines = useMachineViews();
  const scan = useScanWindow();
  const bounds = useBoundaries();

  return (
    <Page
      title="Network"
      lede="What is on Grid right now, read from the contracts on Robinhood Chain and from the host nodes themselves. Nothing on this page comes from a Grid server."
    >
      {!deployment ? (
        <p className="border-t border-line py-8 text-muted">Grid is not deployed on the network this page is connected to, so there is nothing to show.</p>
      ) : (
        <>
          <Guard title="Hosts">
            <HostsSection machines={machines} />
          </Guard>
          {deployment.SwarmMarket && (
            <Guard title="Swarm">
              <SwarmSection bounds={bounds} />
            </Guard>
          )}
          <Guard title="Direct rentals">
            <RentalsSection machines={machines} scan={scan} bounds={bounds} />
          </Guard>
          <Guard title="Bond">
            <BondSection scan={scan} />
          </Guard>
          <Footnote scan={scan} bounds={bounds} />
        </>
      )}
    </Page>
  );
}

/** Keeps a section that fails while rendering from taking the whole page with it. */
class Guard extends Component<{ title: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Section title={this.props.title}>
        <Unavailable />
      </Section>
    );
  }
}

function Unavailable({ error }: { error?: unknown }) {
  return (
    <p className="border-b border-line py-6 text-[13px] text-muted">
      Unavailable right now{error ? `: ${shortError(error).split("\n")[0].slice(0, 160)}` : "."}
    </p>
  );
}

const Reading = () => <p className="border-b border-line py-6 text-muted">Reading…</p>;

/** Where a section's numbers come from, in the corner of its heading. */
const Source = ({ children }: { children: ReactNode }) => <span className="engraved hidden text-faint sm:inline">{children}</span>;

const Note = ({ children }: { children: ReactNode }) => <p className="mt-4 text-[13px] text-faint">{children}</p>;

// ---------------------------------------------------------------- hosts

function HostsSection({ machines }: { machines: MachineFeed }) {
  const { views, reachableHosts, loading, error } = machines;
  const peers = usePeers();
  const groups = gpuGroups(views);
  const hosts = new Set(views.map((v) => v.item.machine.host.toLowerCase())).size;
  const free = views.filter((v) => v.free).length;
  // A relay hears every node's signed heartbeat, so its list is the best count; without one, the listed machines that answer.
  const heard = peers.data ? new Set(peers.data.peers.map((p) => String(typeof p.host === "string" ? p.host : p.peer).toLowerCase())).size : null;
  const online = heard ?? reachableHosts.size;

  return (
    <Section title="Hosts" aside={<Source>Listings and host nodes</Source>}>
      {error && views.length === 0 ? (
        <Unavailable error={error} />
      ) : loading ? (
        <Reading />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-line py-5 sm:grid-cols-4">
            <Stat label="Machines listed">{count(views.length)}</Stat>
            <Stat label="Hosts">{count(hosts)}</Stat>
            <Stat label="Online now">{count(online)}</Stat>
            <Stat label="Free now">{count(free)}</Stat>
          </dl>
          <Note>
            {heard !== null
              ? `Online is the number of hosts a relay has heard from in the last ${HEARTBEAT_TTL_SECONDS} seconds; their heartbeats are signed by the host's wallet.`
              : "No relay answered, so online is the number of hosts with a machine that answered a health check."}
          </Note>

          <div className="mt-8">
            <div className={`${HEAD} grid grid-cols-[minmax(0,1fr)_auto_6.5rem] sm:grid-cols-[minmax(0,1fr)_8rem_10rem]`}>
              <span>GPU</span>
              <span className="text-right">Free</span>
              <span className="text-right">
                <span className="sm:hidden">From</span>
                <span className="hidden sm:inline">From, ETH / GPU-h</span>
              </span>
            </div>
            {groups.length === 0 ? (
              <p className="border-b border-line py-6 text-muted">No machines are listed yet.</p>
            ) : (
              groups.map((g) => (
                <div key={g.key} className={`${ROW} grid grid-cols-[minmax(0,1fr)_auto_6.5rem] items-baseline sm:grid-cols-[minmax(0,1fr)_8rem_10rem]`}>
                  <span className="min-w-0 truncate">
                    {g.model}
                    {g.vramGb > 0 && <span className="tnum ml-2 font-mono text-[12px] text-faint">{g.vramGb} GB</span>}
                  </span>
                  <span className="tnum whitespace-nowrap text-right text-[13px] text-muted">
                    <span className={g.free > 0 ? "text-steel" : undefined}>{g.free}</span> of {g.total}
                  </span>
                  <span className="tnum text-right font-mono text-[13px]">{price(g.from)}</span>
                </div>
              ))
            )}
          </div>
          <Note>Prices are in ETH per GPU-hour. From is the cheapest machine that is free now, or the cheapest listed when none is free.</Note>
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- swarm

/** The price table's rows: a label and how to read it off a period's figures. */
const SWARM_ROWS: [string, (s: PriceStats) => string][] = [
  ["Average", (s) => price(s.mean)],
  ["Median", (s) => price(s.median)],
  ["Paid runs", (s) => (s.runs > 0 ? count(s.runs) : "—")],
  ["Jobs posted", (s) => count(s.jobs)],
];

function SwarmSection({ bounds }: { bounds: Query<Boundaries> }) {
  const jobs = useSwarmJobs();
  const periods = bounds.data ? periodsFor(bounds.data, Infinity) : null;
  const summary = jobs.data ? summarizeSwarm(jobs.data.jobs, jobs.data.posted, periods ?? []) : null;

  return (
    <Section title="Swarm" aside={<Source>SwarmMarket contract</Source>}>
      {jobs.error ? (
        <Unavailable error={jobs.error} />
      ) : !summary ? (
        <Reading />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-line py-5 sm:grid-cols-4">
            <Stat label="Jobs posted">{count(summary.posted)}</Stat>
            <Stat label="Running now">{count(summary.running)}</Stat>
            <Stat label="Tasks done">{count(summary.tasksDone)}</Stat>
            <Stat label="Paid for runs">{fmtEth(summary.paid)} ETH</Stat>
          </dl>

          <div className="mt-8">
            <div className={`${HEAD} grid grid-cols-[minmax(0,1fr)_5rem_5rem] sm:grid-cols-[minmax(0,1fr)_9rem_9rem]`}>
              <span>ETH per run</span>
              {(periods ?? [{ label: "Last 7 d" }, { label: "Last 30 d" }]).map((p) => (
                <span key={p.label} className="text-right">
                  {p.label}
                </span>
              ))}
            </div>
            {!periods ? (
              <p className="border-b border-line py-6 text-[13px] text-muted">
                {bounds.error ? "Unavailable right now: the node would not give block times, which the periods need." : "Reading…"}
              </p>
            ) : (
              SWARM_ROWS.map(([label, value]) => (
                <div key={label} className={`${ROW} grid grid-cols-[minmax(0,1fr)_6.5rem_6.5rem] items-baseline sm:grid-cols-[minmax(0,1fr)_9rem_9rem]`}>
                  <span className="text-muted">{label}</span>
                  {summary.periods.map((p) => (
                    <span key={p.label} className="tnum text-right font-mono text-[13px]">
                      {value(p.stats)}
                    </span>
                  ))}
                </div>
              ))
            )}
          </div>
          <Note>
            Paid for runs is what renters paid hosts for accepted runs; each host receives that less the protocol fee. A job counts in a period
            when it was posted in it. Its price is weighted by the runs that were paid, and every finished task pays two runs. A period with no paid
            run shows a dash.
            {jobs.data?.partial && ` Totals cover the newest ${count(jobs.data.jobs.length)} of ${count(summary.posted)} jobs.`}
          </Note>
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- direct rentals

/** The price table's columns for one or two periods; the first cell of a row spans the width on a phone. */
const PRICE_COLS: Record<number, string> = {
  1: "grid-cols-2 sm:grid-cols-[minmax(0,1.4fr)_1fr_1.3fr]",
  2: "grid-cols-3 sm:grid-cols-[minmax(0,1.4fr)_1fr_1fr_1.3fr]",
};

function RentalsSection({
  machines,
  scan,
  bounds,
}: {
  machines: MachineFeed;
  scan: Query<NonNullable<ReturnType<typeof useScanWindow>["data"]>>;
  bounds: Query<Boundaries>;
}) {
  const rentals = useSettledRentals(scan.data);
  const error = scan.error ?? rentals.error ?? bounds.error;
  const ready = !!scan.data && !!bounds.data && !!rentals.data && !machines.loading;
  const periods = scan.data && bounds.data ? periodsFor(bounds.data, bounds.data.latestTs - scan.data.fromTs, scan.data.from) : [];
  const rows: PriceRow[] = ready ? priceIndex(rentals.data!.settled, machines.views, periods) : [];
  const cols = PRICE_COLS[periods.length] ?? PRICE_COLS[1];
  const priced = rows.filter((r) => r.settled > 0).length;
  const open = machines.views.filter((v) => v.item.machine.available).length;

  return (
    <Section title="Direct rentals" aside={<Source>GridMarket events</Source>}>
      {error && !ready ? (
        <Unavailable error={error} />
      ) : !ready ? (
        <Reading />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-line py-5 sm:grid-cols-3">
            <Stat label="Settled rentals">{count(rentals.data!.total)}</Stat>
            <Stat label="Models with a price">{count(priced)}</Stat>
            <Stat label="Machines open">{count(open)}</Stat>
          </dl>

          <div className="mt-8">
            <div className={`${HEAD} hidden sm:grid ${cols}`}>
              <span>GPU</span>
              {periods.map((p) => (
                <span key={p.label} className="text-right">
                  {p.label}
                </span>
              ))}
              <span className="text-right">Listed now</span>
            </div>
            {rows.length === 0 ? (
              <p className="border-b border-line py-6 text-muted">No machine is listed and no rental has settled yet.</p>
            ) : (
              rows.map((row) => (
                <div key={row.model} className={`${ROW} grid gap-y-2 ${cols}`}>
                  <span className="col-span-full min-w-0 truncate sm:col-span-1">{row.model}</span>
                  {row.periods.map((p, i) => (
                    <Cell key={periods[i].label} label={periods[i].label}>
                      {p.median !== null ? (
                        <>
                          <span className="font-mono text-[13px]">{price(p.median)}</span>
                          <span className="block text-[12px] text-faint">
                            {count(p.count)} {p.count === 1 ? "rental" : "rentals"}
                          </span>
                        </>
                      ) : (
                        <span className="font-mono text-[13px] text-faint">—</span>
                      )}
                    </Cell>
                  ))}
                  <Cell label="Listed now">
                    {row.listed !== null ? (
                      <>
                        <span className="font-mono text-[13px]">{price(row.listed)}</span>
                        <span className="block text-[12px] text-faint">
                          {row.settled === 0 ? "listed, none settled yet" : `${count(row.listedCount)} listed`}
                        </span>
                      </>
                    ) : (
                      <span className="font-mono text-[13px] text-faint">—</span>
                    )}
                  </Cell>
                </div>
              ))
            )}
          </div>
          <Note>
            Median ETH per GPU-hour. A settled price is the hourly price a rental was booked at, divided by the machine's GPUs, for rentals that
            ended in the period and cost something. Listed is the median asking price of machines that are open to rent.
            {rentals.data!.total > rentals.data!.settled.length && " Prices are taken from the latest settled rentals; the count includes all of them."}
          </Note>
        </>
      )}
    </Section>
  );
}

/** A figure with its period named above it on a phone, where the table's header row is hidden. */
function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="tnum min-w-0 sm:text-right">
      <span className="engraved block text-faint sm:hidden">{label}</span>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- bond

function BondSection({ scan }: { scan: Query<NonNullable<ReturnType<typeof useScanWindow>["data"]>> }) {
  const deployment = useDeployment();
  const bonds = useBonds(scan.data);
  const { data: minBond } = useReadContract({
    abi: stakeRegistryAbi,
    address: deployment?.StakeRegistry,
    functionName: "minBond",
    query: { enabled: !!deployment, refetchInterval: 60_000 },
  });
  const data = bonds.data;
  const error = scan.error ?? bonds.error;
  const atLeast = data && !data.complete ? "≥ " : "";

  return (
    <Section title="Bond" aside={<Source>StakeRegistry contract</Source>}>
      {error && !data ? (
        <Unavailable error={error} />
      ) : !data ? (
        <Reading />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-line py-5 sm:grid-cols-4">
            <Stat label="GRID bonded">
              {atLeast}
              {grid(data.bonded)}
            </Stat>
            <Stat label="Unbonding">
              {atLeast}
              {grid(data.unbonding)}
            </Stat>
            <Stat label="GRID burned">{grid(data.burned)}</Stat>
            <Stat label="Hosts bonded">
              {atLeast}
              {count(data.bondedHosts)}
            </Stat>
          </dl>
          <Note>
            {minBond === undefined ? "" : minBond === 0n ? "Bonding is switched off on this deployment. " : `A host needs ${grid(minBond)} GRID bonded to be rentable after its trial. `}
            {data.held !== null && `The registry holds ${grid(data.held)} GRID in all, bonded and unbonding. `}
            Bonded and unbonding are what each host has in the registry now, after unbonds and slashes. Burned is the GRID taken from hosts that cheated
            {scan.data?.whole ? "." : ", counted over the window that was read."}
            {!data.complete && " The hosts found do not account for all of it, so the figures are lower bounds: some GRID belongs to hosts that bonded before that window."}
          </Note>
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- footnote

function Footnote({ scan, bounds }: { scan: Query<NonNullable<ReturnType<typeof useScanWindow>["data"]>>; bounds: Query<Boundaries> }) {
  if (!scan.data) return null;
  const span = bounds.data ? bounds.data.latestTs - scan.data.fromTs : null;
  return (
    <p className="mt-16 border-t border-line pt-4 text-[13px] text-faint">
      {scan.data.whole
        ? "Rentals and bonds are read from every event since the chain's first block."
        : `Rentals and bonds are read from the events of the last ${span === null ? "" : `${fmtSpan(span, true)} (`}${count(WINDOW_BLOCKS)} blocks${span === null ? "" : ")"} of this chain; earlier events are not scanned.`}{" "}
      Jobs, machines and bond balances are read from the contracts' current state, so they are not limited to that window.
    </p>
  );
}
