import { useState } from "react";
import type { ContractFunctionReturnType } from "viem";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { gridMarketAbi, parseMetadata, stakeRegistryAbi, TRIAL_MAX_DEPOSIT_WEI } from "@grid/shared";
import { BlockTrack } from "../components/BlockTrack";
import { Button, ErrorText, Input, linkClass, Status, type Tone } from "../components/ui";
import { useDeployment } from "../contracts";
import { fmtEth, fmtGb, shortAddr, shortCpu } from "../lib/format";
import { endpointBlocked, useHealth } from "../lib/hooks";
import { useTx } from "../lib/useTx";
import { Link, navigate } from "../router";

type Listing = ContractFunctionReturnType<typeof gridMarketAbi, "view", "getListings">[number];

/** Listings are read in fixed pages so one oversized call can never blank the market. */
const PAGE = 50n;
const MAX_HOURS = 720;

/** Desktop column template, shared by the header and every row. */
const COLS =
  "sm:grid sm:grid-cols-[minmax(0,1.25fr)_minmax(0,1.25fr)_minmax(0,1.25fr)_7rem_6rem_4.5rem] sm:items-center sm:gap-6";

export function Market() {
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

  const items = (pages ?? [])
    .flatMap((p) => (p.status === "success" ? [...p.result] : []))
    // Rentable machines first, cheapest first within each group.
    .sort((a, b) =>
      a.rentable !== b.rentable ? (a.rentable ? -1 : 1) : a.machine.pricePerHour < b.machine.pricePerHour ? -1 : 1,
    );
  const loading = !!deployment && (count === undefined || (offsets.length > 0 && !pages)) && !countError;
  const error = countError ?? pageError;

  return (
    <>
      <section>
        <h1 className="rise font-serif text-[40px] font-light leading-[1.05] tracking-[-0.015em] sm:text-[56px]">
          Rent GPUs from their owners.
        </h1>
        <p className="rise mt-6 max-w-[60ch] text-[16px] text-muted [animation-delay:90ms]">
          Each machine below is listed by the person who runs it. When you rent one, the ETH for the hours you choose is
          held by the GridMarket contract; the host is paid for the minutes you use and the rest is returned to you when
          the rental ends.
        </p>
        <div className="rise mt-10 [animation-delay:180ms]">
          <BlockTrack />
        </div>
      </section>

      <section className="mt-16 sm:mt-24">
        <div className="flex items-end justify-between gap-4 border-b border-ink/80 pb-2">
          <h2 className="engraved text-ink">
            Machines{!loading && <span className="tnum ml-2 text-faint">{String(items.length).padStart(2, "0")}</span>}
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
        ) : (
          items.map((item) => <MachineRow key={item.id.toString()} item={item} bondingOff={minBond === 0n} />)
        )}
      </section>
    </>
  );
}

function MachineRow({ item, bondingOff }: { item: Listing; bondingOff: boolean }) {
  const { id, machine, rentable, hostBonded } = item;
  const meta = parseMetadata(machine.metadata);
  const blocked = endpointBlocked(meta?.endpoint);
  const health = useHealth(meta?.endpoint);
  const { address } = useAccount();
  const deployment = useDeployment()!;
  const tx = useTx();
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState(1);

  const busy = machine.activeRental !== 0n;
  const isMine = !!address && address.toLowerCase() === machine.host.toLowerCase();
  // An unbonded host may hold at most TRIAL_MAX_DEPOSIT per rental (GridMarket.TRIAL_MAX_DEPOSIT).
  const capped = !bondingOff && !hostBonded;
  const maxHours = Math.min(MAX_HOURS, capped ? Number(TRIAL_MAX_DEPOSIT_WEI / machine.pricePerHour) : MAX_HOURS);
  const online = health.isSuccess;
  const canRent = rentable && !isMine && !blocked && online && maxHours >= 1;
  const total = machine.pricePerHour * BigInt(Math.max(1, hours));

  const [tone, label]: [Tone, string] = !machine.available
    ? ["off", "Paused"]
    : busy
      ? ["busy", "Rented"]
      : blocked
        ? ["off", "Unreachable"]
        : health.isPending
          ? ["off", "Checking"]
          : !online
            ? ["off", "Offline"]
            : !rentable
              ? ["off", "Needs bond"]
              : ["ok", "Available"];

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
  const host = [shortAddr(machine.host), isMine ? "you" : null, bondingOff ? null : hostBonded ? "bonded" : "trial"]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="border-b border-line">
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
