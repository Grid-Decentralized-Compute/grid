import { useState } from "react";
import type { ContractFunctionReturnType } from "viem";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { gridMarketAbi, parseMetadata, stakeRegistryAbi, TRIAL_MAX_DEPOSIT_WEI } from "@grid/shared";
import { Badge, Button, Card, ErrorText, Input, Muted } from "../components/ui";
import { useDeployment } from "../contracts";
import { fmtEth, shortAddr } from "../lib/format";
import { endpointBlocked, useHealth } from "../lib/hooks";
import { useTx } from "../lib/useTx";

type Listing = ContractFunctionReturnType<typeof gridMarketAbi, "view", "getListings">[number];

/** Listings are read in fixed pages so one oversized call can never blank the market. */
const PAGE = 50n;
const MAX_HOURS = 720;

export function Market({ onRented }: { onRented: () => void }) {
  const deployment = useDeployment();
  const { data: count } = useReadContract({
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
  const { data: pages, isLoading, error } = useReadContracts({
    contracts: deployment
      ? offsets.map(
          (offset) =>
            ({ abi: gridMarketAbi, address: deployment.GridMarket, functionName: "getListings", args: [offset, PAGE] }) as const,
        )
      : [],
    query: { enabled: !!deployment && offsets.length > 0, refetchInterval: 5_000 },
  });

  if (!deployment) return null;
  if (count === undefined || (offsets.length > 0 && isLoading && !pages)) return <Muted>Loading machines…</Muted>;
  if (error) return <ErrorText>{error.message}</ErrorText>;

  const items = offsets.length === 0 ? [] : (pages ?? []).flatMap((p) => (p.status === "success" ? [...p.result] : []));
  const bondingOff = minBond === 0n;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Machines</h1>
        <span className="text-sm text-zinc-500">
          {items.length} listed · paid up front in ETH, billed per minute, unused time refunded
        </span>
      </div>
      {items.length === 0 && (
        <Card>
          <Muted>
            Nothing listed yet. Start a host node (<code>npm run node</code>) and it shows up here within a few seconds.
          </Muted>
        </Card>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {items.map((item) => (
          <MachineCard key={item.id.toString()} item={item} bondingOff={bondingOff} onRented={onRented} />
        ))}
      </div>
    </div>
  );
}

function MachineCard({ item, bondingOff, onRented }: { item: Listing; bondingOff: boolean; onRented: () => void }) {
  const { id, machine, rentable, hostBonded } = item;
  const meta = parseMetadata(machine.metadata);
  const blocked = endpointBlocked(meta?.endpoint);
  const health = useHealth(meta?.endpoint);
  const online = health.isSuccess;
  const { address } = useAccount();
  const deployment = useDeployment()!;
  const tx = useTx();
  const [hours, setHours] = useState(1);

  const name = meta?.name || `Machine #${id}`;
  const busy = machine.activeRental !== 0n;
  const isMine = !!address && address.toLowerCase() === machine.host.toLowerCase();
  // An unbonded host may only hold TRIAL_MAX_DEPOSIT per rental (GridMarket.TRIAL_MAX_DEPOSIT).
  const capped = !bondingOff && !hostBonded;
  const maxHours = Math.min(MAX_HOURS, capped ? Number(TRIAL_MAX_DEPOSIT_WEI / machine.pricePerHour) : MAX_HOURS);
  const canOffer = rentable && !isMine && !blocked && maxHours >= 1;
  const total = machine.pricePerHour * BigInt(Math.max(1, hours));

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
    if (ok) onRented();
  }

  const unavailableReason = isMine
    ? "your machine"
    : busy
      ? "currently rented"
      : !machine.available
        ? "paused by host"
        : blocked
          ? "host must publish an https:// endpoint"
          : !rentable
            ? "host needs a GRID bond"
            : "price is above the trial cap for an unbonded host";

  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-semibold">
            {name} <span className="text-xs font-normal text-zinc-500">#{id.toString()}</span>
          </div>
          <div className="text-sm text-zinc-400">
            host <span className="font-mono">{shortAddr(machine.host)}</span>
            {isMine && " (you)"}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          {blocked ? (
            <Badge tone="bad">unreachable (http)</Badge>
          ) : (
            <Badge tone={online ? "good" : "bad"}>{online ? "online" : "offline"}</Badge>
          )}
          {bondingOff ? (
            <Badge>no bond needed</Badge>
          ) : (
            <Badge tone={hostBonded ? "good" : "warn"}>{hostBonded ? "bonded" : "trial"}</Badge>
          )}
          {busy && <Badge>rented</Badge>}
          {!machine.available && <Badge>paused</Badge>}
        </div>
      </div>

      {meta ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-zinc-500">GPU</dt>
          <dd>{meta.gpuCount > 0 ? `${meta.gpuCount}× ${meta.gpu}, ${meta.vramGb} GB` : meta.gpu || "none"}</dd>
          <dt className="text-zinc-500">CPU</dt>
          <dd className="truncate" title={meta.cpu}>
            {meta.cpu || "—"}
          </dd>
          <dt className="text-zinc-500">RAM / disk</dt>
          <dd>
            {meta.ramGb} GB / {meta.diskGb} GB
          </dd>
          <dt className="text-zinc-500">OS</dt>
          <dd>{meta.os || "—"}</dd>
        </dl>
      ) : (
        <Muted>No machine details published.</Muted>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3 border-t border-zinc-800 pt-3">
        <div className="text-2xl font-semibold">
          {fmtEth(machine.pricePerHour)} <span className="text-sm font-normal text-zinc-400">ETH / hour</span>
        </div>
        {canOffer ? (
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={maxHours}
              value={hours}
              onChange={(e) => setHours(Math.min(maxHours, Math.max(1, Math.floor(Number(e.target.value) || 1))))}
              className="w-20"
            />
            <span className="text-sm text-zinc-400">h</span>
            <Button onClick={rent} disabled={!address || !!tx.pending}>
              {tx.pending ?? `Rent for ${fmtEth(total)} ETH`}
            </Button>
          </div>
        ) : (
          <span className="text-sm text-zinc-500">{unavailableReason}</span>
        )}
      </div>
      {canOffer && capped && (
        <Muted>Trial host (no GRID bond yet): at most {maxHours} h per rental.</Muted>
      )}
      {!address && canOffer && <Muted>Connect a wallet to rent.</Muted>}
      <ErrorText>{tx.error}</ErrorText>
    </Card>
  );
}
