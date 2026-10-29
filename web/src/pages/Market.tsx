import { Fragment, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { gridMarketAbi, parseMetadata, stakeRegistryAbi, TRIAL_MAX_DEPOSIT_WEI } from "@grid/shared";
import { BlockTrack } from "../components/BlockTrack";
import { GpuIndex } from "../components/GpuIndex";
import { NetworkPlate } from "../components/NetworkPlate";
import { Button, ErrorText, Input, linkClass, Status } from "../components/ui";
import { useDeployment } from "../contracts";
import { fmtEth, fmtGb, shortAddr, shortCpu } from "../lib/format";
import { healthQuery } from "../lib/hooks";
import { applyFilters, filtersActive, gpuGroups, type MachineView, machineStatus, useFilters } from "../lib/machines";
import { useTx } from "../lib/useTx";
import { Link, navigate } from "../router";
import { Swarm } from "./Swarm";

/** Listings are read in fixed pages so one oversized call can never blank the market. */
const PAGE = 50n;
const MAX_HOURS = 720;

/** Desktop column template, shared by the header and every row. */
const COLS =
  "sm:grid sm:grid-cols-[minmax(0,1.25fr)_minmax(0,1.25fr)_minmax(0,1.25fr)_7rem_6rem_4.5rem] sm:items-center sm:gap-6";

const HEADLINE = "Decentralized compute network.";

export type MarketMode = "direct" | "swarm";

const MODES: { mode: MarketMode; href: string; title: string; line: string }[] = [
  {
    mode: "direct",
    href: "/",
    title: "Direct",
    line: "One machine, yours alone, with an SSH login. If its host goes offline, the rental stops and you pay only for the minutes used.",
  },
  {
    mode: "swarm",
    href: "/swarm",
    title: "Swarm",
    line: "One job split into tasks and spread across many hosts. Each task runs on two machines and is paid only when their outputs match.",
  },
];

export function Market({ mode }: { mode: MarketMode }) {
  return (
    <>
      <section className="grid gap-x-14 gap-y-12 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-end">
        <div>
          <p className="rise engraved text-steel">A GPU market on Robinhood Chain</p>
          <h1 className="mt-5 text-balance font-serif text-[40px] font-light leading-[1.05] tracking-[-0.015em] sm:text-[56px]">
            {HEADLINE.split(" ").map((word, i) => (
              <Fragment key={i}>
                {i > 0 && " "}
                <span className="reveal-mask">
                  <span className="reveal" style={{ ["--i" as string]: i }}>
                    {word}
                  </span>
                </span>
              </Fragment>
            ))}
          </h1>
          <p className="rise mt-6 max-w-[56ch] text-[16px] text-muted [animation-delay:90ms]">
            People with GPUs list them at a price they set. People who need compute rent a machine by the hour, or post a
            job that runs across many of them. Grid has no servers of its own: the ETH is held by contracts on Robinhood
            Chain, and nodes reach each other directly over a peer-to-peer network.
          </p>
          <div className="rise mt-10 [animation-delay:180ms]">
            <BlockTrack />
          </div>
        </div>
        <NetworkPlate className="rise max-w-[420px] [animation-delay:240ms] lg:max-w-none" />
      </section>

      <div role="tablist" aria-label="How to rent" className="relative mt-16 grid gap-px border-y border-line sm:mt-24 sm:grid-cols-2">
        {/* One steel index that travels to the chosen tab. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 hidden h-0.5 w-1/2 bg-steel transition-transform duration-700 ease-[cubic-bezier(0.2,0.7,0.2,1)] sm:block"
          style={{ transform: `translateX(${mode === "swarm" ? "100%" : "0%"})` }}
        />
        {MODES.map((m) => {
          const active = m.mode === mode;
          return (
            <Link
              key={m.mode}
              href={m.href}
              scroll={false}
              role="tab"
              aria-selected={active}
              className={`group block border-t-2 py-5 pr-8 transition-colors ${active ? "border-steel sm:border-transparent" : "border-transparent hover:border-line"}`}
            >
              <span className={`engraved transition-colors duration-500 ${active ? "text-steel" : "text-ink"}`}>{m.title}</span>
              <span
                className={`mt-2 block max-w-[46ch] text-[14px] transition-colors duration-500 ${active ? "text-ink" : "text-muted group-hover:text-ink"}`}
              >
                {m.line}
              </span>
            </Link>
          );
        })}
      </div>

      {mode === "direct" ? <Machines /> : <Swarm />}
    </>
  );
}

function Machines() {
  const deployment = useDeployment();
  const { data: count, error: countError } = useReadContract({
    abi: gridMarketAbi,
    address: deployment?.GridMarket,
    functionName: "machineCount",
    query: { enabled: !!deployment, refetchInterval: 5_000 },
  });
  const { data: minBond } = useReadContract({
    abi: stakeRegistryAbi,
    address: deployment?.StakeRegistry,
    functionName: "minBond",
    query: { enabled: !!deployment, refetchInterval: 30_000 },
  });
  const offsets =
    count === undefined ? [] : Array.from({ length: Number((count + PAGE - 1n) / PAGE) }, (_, i) => BigInt(i) * PAGE);
  const { data: pages, error: pageError } = useReadContracts({
    contracts: deployment
      ? offsets.map(
          (offset) =>
            ({ abi: gridMarketAbi, address: deployment.GridMarket, functionName: "getListings", args: [offset, PAGE] }) as const,
        )
      : [],
    query: { enabled: !!deployment && offsets.length > 0, refetchInterval: 5_000 },
  });

  const items = (pages ?? []).flatMap((p) => (p.status === "success" ? [...p.result] : []));
  const metas = items.map((item) => parseMetadata(item.machine.metadata));
  // Every node's /health, once each; the rows below read the same cached results.
  // At most 100 nodes are checked: a flood of listings cannot turn visitors into a request cannon.
  const health = useQueries({ queries: metas.map((meta, i) => healthQuery(i < 100 ? meta?.endpoint : undefined)) });
  const views: MachineView[] = items.map((item, i) => ({ item, meta: metas[i], ...machineStatus(item, metas[i], health[i]) }));
  const [filters, setFilters, clearFilters] = useFilters();
  const groups = gpuGroups(views);
  const shown = applyFilters(views, filters);
  const filtering = filtersActive(filters);

  const loading = !!deployment && (count === undefined || (offsets.length > 0 && !pages)) && !countError;
  const error = countError ?? pageError;

  return (
    <>
      {views.length > 0 && <GpuIndex groups={groups} filters={filters} onChange={setFilters} onClear={clearFilters} />}
      <section className="mt-12">
        <div className="flex items-end justify-between gap-4 border-b border-rule pb-2">
          <h2 className="engraved text-ink">
            Machines
            {!loading && (
              <span className="tnum ml-2 text-faint">
                {String(shown.length).padStart(2, "0")}
                {filtering && ` / ${String(views.length).padStart(2, "0")}`}
              </span>
            )}
          </h2>
          <Link href="/host" className="text-[13px] text-muted transition-colors hover:text-steel">
            List a machine
          </Link>
        </div>
        <div className={`engraved hidden border-b border-line py-2.5 text-faint ${COLS}`}>
          <span>Machine</span>
          <span>GPU</span>
          <span>System</span>
          <span>Status</span>
          <span className="text-right">ETH / hour</span>
          <span />
        </div>

        {error ? (
          <ErrorText className="py-8">Could not read the market: {error.message.split("\n")[0]}</ErrorText>
        ) : loading ? (
          <p className="border-b border-line py-8 text-muted">Reading the market…</p>
        ) : items.length === 0 ? (
          <p className="border-b border-line py-8 text-muted">
            No machines are listed yet.{" "}
            <Link href="/host" className={linkClass}>
              List yours
            </Link>
          </p>
        ) : shown.length === 0 ? (
          <p className="border-b border-line py-8 text-muted">
            No machine matches these filters.{" "}
            <button type="button" onClick={clearFilters} className={linkClass}>
              Clear filters
            </button>
          </p>
        ) : (
          shown.map((view) => <MachineRow key={view.item.id.toString()} view={view} bondingOff={minBond === 0n} />)
        )}
      </section>
    </>
  );
}

function MachineRow({ view, bondingOff }: { view: MachineView; bondingOff: boolean }) {
  const { item, meta, tone, label } = view;
  const { id, machine, hostBonded } = item;
  const { address } = useAccount();
  const deployment = useDeployment()!;
  const tx = useTx();
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState(1);

  const isMine = !!address && address.toLowerCase() === machine.host.toLowerCase();
  // An unbonded host may hold at most TRIAL_MAX_DEPOSIT per rental (GridMarket.TRIAL_MAX_DEPOSIT).
  const capped = !bondingOff && !hostBonded;
  const maxHours = Math.min(MAX_HOURS, capped ? Number(TRIAL_MAX_DEPOSIT_WEI / machine.pricePerHour) : MAX_HOURS);
  // "Free" already means listed, not rented, reachable and allowed to rent (lib/machines.ts).
  const canRent = view.free && !isMine && maxHours >= 1;
  const total = machine.pricePerHour * BigInt(Math.max(1, hours));
  const swarmOnly = meta?.p2p?.direct === false;

  async function rent() {
    const ok = await tx.run("Renting…", [
      () =>
        tx.write({
          abi: gridMarketAbi,
          address: deployment.GridMarket,
          functionName: "rent",
          args: [id, BigInt(hours)],
          value: total,
        }),
    ]);
    if (ok) navigate("/rentals");
  }

  const gpu = meta ? (meta.gpuCount > 0 ? `${meta.gpuCount > 1 ? `${meta.gpuCount}× ` : ""}${meta.gpu}` : "No GPU") : "—";
  const host = [
    shortAddr(machine.host),
    isMine ? "you" : null,
    swarmOnly ? "relayed" : null,
    bondingOff ? null : hostBonded ? "bonded" : "trial",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="group relative border-b border-line">
      {/* A steel index lights beside the row under the pointer. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -left-3.5 top-[26px] h-3 w-[2px] origin-center scale-y-0 bg-steel transition-transform duration-300 ease-out group-hover:scale-y-100"
      />
      <div className={`flex flex-col gap-1 py-4 ${COLS}`}>
        <div className="min-w-0">
          <div className="truncate font-medium">{meta?.name || `Machine ${id}`}</div>
          <div className="mt-0.5 truncate font-mono text-[12px] text-faint">{host}</div>
        </div>
        <div className="min-w-0">
          <div className="truncate">{gpu}</div>
          {meta && meta.gpuCount > 0 && <div className="tnum mt-0.5 text-[13px] text-muted">{meta.vramGb} GB VRAM</div>}
        </div>
        <div className="min-w-0">
          <div className="tnum truncate">{meta ? `${fmtGb(meta.ramGb)} RAM · ${fmtGb(meta.diskGb)} disk` : "—"}</div>
          {meta?.cpu && <div className="mt-0.5 truncate text-[13px] text-muted">{shortCpu(meta.cpu)}</div>}
        </div>
        <div className="mt-3 flex items-center gap-5 sm:contents">
          <Status tone={tone}>{label}</Status>
          <div className="tnum ml-auto font-mono sm:ml-0 sm:text-right">
            {fmtEth(machine.pricePerHour)}
            <span className="text-faint sm:hidden"> ETH/h</span>
          </div>
          <div className="sm:text-right">
            {canRent && (
              <Button variant={open ? "quiet" : "secondary"} onClick={() => setOpen(!open)} aria-expanded={open}>
                {open ? "Close" : "Rent"}
              </Button>
            )}
          </div>
        </div>
      </div>

      {open && canRent && (
        <div className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-[3px] bg-plate px-4 py-3 text-[13px]">
          <label className="flex items-center gap-2 text-muted">
            Hours
            <Input
              type="number"
              min={1}
              max={maxHours}
              value={hours}
              onChange={(e) => setHours(Math.min(maxHours, Math.max(1, Math.floor(Number(e.target.value) || 1))))}
              className="w-16"
              autoFocus
            />
          </label>
          <span className="tnum font-mono text-muted">
            × {fmtEth(machine.pricePerHour)} = <span className="font-medium text-ink">{fmtEth(total)} ETH</span>
          </span>
          <span className="text-faint">
            {capped ? `Trial host: up to ${maxHours} h per rental.` : "Unused time is refunded."}
          </span>
          <div className="w-full sm:ml-auto sm:w-auto">
            {address ? (
              <Button onClick={rent} disabled={!!tx.pending} className="w-full sm:w-auto">
                {tx.pending ?? "Confirm rental"}
              </Button>
            ) : (
              <span className="text-muted">Connect a wallet to rent.</span>
            )}
          </div>
          <ErrorText className="w-full">{tx.error}</ErrorText>
        </div>
      )}
    </div>
  );
}
