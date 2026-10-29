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
import { Button, ErrorText, linkClass, Page, Stat, Status } from "../components/ui";
import { useDeployment } from "../contracts";
import { fmtDate, fmtDuration, fmtEth, shortError } from "../lib/format";
import { useNow } from "../lib/hooks";
import { useTx } from "../lib/useTx";
import { Link } from "../router";

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

  if (!address) {
    return (
      <Page title="Rentals" lede="Rentals paid for from this wallet. If you end one early, the time you did not use is refunded.">
        <p className="text-muted">Connect a wallet to see its rentals.</p>
      </Page>
    );
  }
  if (!deployment) {
    return (
      <Page title="Rentals" lede="Rentals paid for from this wallet. If you end one early, the time you did not use is refunded.">
        <p className="border-t border-line py-8 text-muted">
          No rentals yet.{" "}
          <Link href="/" className={linkClass}>
            Find a machine
          </Link>
        </p>
      </Page>
    );
  }

  const list = [...(rentals ?? [])].reverse();
  return (
    <Page title="Rentals" lede="Rentals paid for from this wallet. If you end one early, the time you did not use is refunded.">
      {owed !== undefined && owed > 0n && (
        <div className="mb-10 flex flex-wrap items-center justify-between gap-3 rounded-[3px] bg-plate px-4 py-3 text-[13px]">
          <span>
            <span className="tnum font-mono font-medium">{fmtEth(owed)} ETH</span> refunded and ready to withdraw.
          </span>
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
          <ErrorText className="w-full">{tx.error}</ErrorText>
        </div>
      )}

      <div className="border-t border-line">
        {isLoading ? (
          <p className="py-8 text-muted">Reading your rentals…</p>
        ) : list.length === 0 ? (
          <p className="py-8 text-muted">
            No rentals yet.{" "}
            <Link href="/" className={linkClass}>
              Find a machine
            </Link>
          </p>
        ) : (
          list.map((view) => <RentalRow key={view.id.toString()} view={view} />)
        )}
      </div>
    </Page>
  );
}

function RentalRow({ view }: { view: RentalView }) {
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
      setAccessError("This host publishes a plain http address, so the password would travel unencrypted.");
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
      if (!res.ok) throw new Error(reply.error ?? `The host replied ${res.status}`);
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

  const gpu = meta && meta.gpuCount > 0 ? `${meta.gpuCount > 1 ? `${meta.gpuCount}× ` : ""}${meta.gpu}` : null;

  return (
    <div className="border-b border-line py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">{meta?.name || `Machine ${rental.machineId}`}</div>
          <div className="mt-0.5 text-[13px] text-muted">
            {[gpu, `started ${fmtDate(rental.startedAt)}`, `rental ${id}`].filter(Boolean).join(" · ")}
          </div>
        </div>
        <Status tone={!active ? "off" : expired ? "busy" : "ok"}>
          {!active ? "Ended" : expired ? "Time used up" : "Running"}
        </Status>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <Stat label="Paid">{fmtEth(rental.deposit)} ETH</Stat>
        <Stat label="Booked">{rental.paidHours.toString()} h</Stat>
        <Stat label="Used so far">{cost !== null ? `${fmtEth(cost)} ETH` : "Settled"}</Stat>
        <Stat label="Time left">{active ? fmtDuration(endsAt - now) : "—"}</Stat>
      </dl>

      {active && (
        <div className="mt-5 flex flex-wrap gap-2">
          <Button onClick={getAccess} disabled={fetching || !meta}>
            {fetching ? "Waiting for signature…" : access ? "Refresh SSH access" : "Get SSH access"}
          </Button>
          <Button variant="danger" onClick={end} disabled={!!tx.pending}>
            {tx.pending ?? (expired ? "Settle" : "End rental")}
          </Button>
        </div>
      )}

      {access && active && (
        <div className="mt-4 overflow-x-auto rounded-[3px] bg-plate px-4 py-3 font-mono text-[13px] leading-relaxed">
          <div>
            <span className="select-none text-faint">$ </span>
            {access.command}
          </div>
          <div>
            <span className="select-none text-faint">password </span>
            {access.password}
          </div>
          <div className="text-faint">access ends {fmtDate(access.endsAt)}</div>
        </div>
      )}
      <ErrorText className="mt-3">{accessError}</ErrorText>
      <ErrorText className="mt-3">{tx.error}</ErrorText>
    </div>
  );
}
