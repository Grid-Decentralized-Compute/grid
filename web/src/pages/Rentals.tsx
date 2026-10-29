import { useState } from "react";
import type { ContractFunctionReturnType } from "viem";
import { useAccount, useReadContract, useSignMessage } from "wagmi";
import {
  type AccessInfo,
  type AccessRequest,
  accessMessage,
  costSoFar,
  gridMarketAbi,
  isSecureEndpoint,
  parseMetadata,
} from "@grid/shared";
import { Badge, Button, Card, ErrorText, Muted, Stat } from "../components/ui";
import { useDeployment } from "../contracts";
import { fmtDate, fmtDuration, fmtEth, shortError } from "../lib/format";
import { useNow } from "../lib/hooks";
import { useTx } from "../lib/useTx";

type RentalView = ContractFunctionReturnType<typeof gridMarketAbi, "view", "getRentalsOf">[number];

export function Rentals() {
  const deployment = useDeployment();
  const { address } = useAccount();
  const enabled = !!deployment && !!address;
  const { data: rentals, isLoading } = useReadContract({
    abi: gridMarketAbi,
    address: deployment?.GridMarket,
    functionName: "getRentalsOf",
    args: [address!],
    query: { enabled, refetchInterval: 5_000 },
  });
  const { data: owed } = useReadContract({
    abi: gridMarketAbi,
    address: deployment?.GridMarket,
    functionName: "balances",
    args: [address!],
    query: { enabled, refetchInterval: 5_000 },
  });
  const tx = useTx();

  if (!deployment) return null;
  if (!address) {
    return (
      <Card>
        <Muted>Connect a wallet to see your rentals.</Muted>
      </Card>
    );
  }

  const list = [...(rentals ?? [])].reverse();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">My rentals</h1>

      {owed !== undefined && owed > 0n && (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-medium">{fmtEth(owed)} ETH to withdraw</div>
            <Muted>Refunds for unused time sit in the contract until you pull them.</Muted>
          </div>
          <Button
            disabled={!!tx.pending}
            onClick={() =>
              tx.run("Withdrawing…", [
                () => tx.write({ abi: gridMarketAbi, address: deployment.GridMarket, functionName: "withdraw" }),
              ])
            }
          >
            {tx.pending ?? "Withdraw"}
          </Button>
        </Card>
      )}
      <ErrorText>{tx.error}</ErrorText>

      {isLoading && <Muted>Loading…</Muted>}
      {!isLoading && list.length === 0 && (
        <Card>
          <Muted>No rentals yet. Pick a machine in the market.</Muted>
        </Card>
      )}
      {list.map((view) => (
        <RentalCard key={view.id.toString()} view={view} />
      ))}
    </div>
  );
}

function RentalCard({ view }: { view: RentalView }) {
  const { id, rental, machine } = view;
  const meta = parseMetadata(machine.metadata);
  const now = useNow();
  const deployment = useDeployment()!;
  const tx = useTx();
  const { signMessageAsync } = useSignMessage();
  const [access, setAccess] = useState<AccessInfo | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  const endsAt = Number(rental.startedAt + rental.paidHours * 3600n);
  const active = !rental.ended;
  const expired = now >= endsAt;
  const cost = active ? costSoFar(rental, now) : null;

  // Proves to the host that this wallet holds the rental; the host checks the signature
  // against the renter address stored on-chain and replies with the SSH details.
  async function getAccess() {
    if (!meta) return;
    if (!isSecureEndpoint(meta.endpoint)) {
      // The reply carries the SSH password; never fetch it over plain http from a remote host.
      setAccessError("This host publishes a plain http:// endpoint, so the password would travel unencrypted. Ask the host to serve https.");
      return;
    }
    setFetching(true);
    setAccessError(null);
    try {
      const ts = Math.floor(Date.now() / 1000);
      const sig = await signMessageAsync({ message: accessMessage(id, ts) });
      const body: AccessRequest = { ts, sig };
      const res = await fetch(`${meta.endpoint}/access/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      const reply = await res.json();
      if (!res.ok) throw new Error(reply.error ?? `host replied ${res.status}`);
      setAccess(reply as AccessInfo);
    } catch (e) {
      setAccessError(shortError(e));
    } finally {
      setFetching(false);
    }
  }

  function end() {
    void tx.run("Ending…", [
      () => tx.write({ abi: gridMarketAbi, address: deployment.GridMarket, functionName: "endRental", args: [id] }),
    ]);
  }

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-semibold">
            {meta?.name || `Machine #${rental.machineId}`}{" "}
            <span className="text-xs font-normal text-zinc-500">rental #{id.toString()}</span>
          </div>
          <div className="text-sm text-zinc-400">
            {meta && meta.gpuCount > 0 ? `${meta.gpuCount}× ${meta.gpu}` : (meta?.gpu ?? "")} · started {fmtDate(rental.startedAt)}
          </div>
        </div>
        <Badge tone={!active ? "neutral" : expired ? "warn" : "good"}>
          {!active ? "ended" : expired ? "time used up" : "active"}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Paid" value={`${fmtEth(rental.deposit)} ETH`} />
        <Stat label="Booked" value={`${rental.paidHours.toString()} h`} />
        <Stat label="Used so far" value={cost !== null ? `${fmtEth(cost)} ETH` : "settled"} />
        <Stat label="Time left" value={active ? fmtDuration(endsAt - now) : "—"} />
      </div>

      {active && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={getAccess} disabled={fetching || !meta}>
            {fetching ? "Signing…" : "Get SSH access"}
          </Button>
          <Button variant="danger" onClick={end} disabled={!!tx.pending}>
            {tx.pending ?? (expired ? "Settle" : "End rental")}
          </Button>
        </div>
      )}

      {access && active && (
        <div className="space-y-1 rounded-md bg-zinc-950 p-3 font-mono text-sm">
          <div>
            <span className="text-zinc-500">$ </span>
            {access.command}
          </div>
          <div>
            <span className="text-zinc-500">password: </span>
            {access.password}
          </div>
          <div className="text-xs text-zinc-500">access ends {fmtDate(access.endsAt)}</div>
        </div>
      )}
      <ErrorText>{accessError}</ErrorText>
      <ErrorText>{tx.error}</ErrorText>
    </Card>
  );
}
