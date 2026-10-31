import { useState } from "react";
import type { ContractFunctionReturnType } from "viem";
import { useAccount, useChainId, useReadContract, useSignMessage } from "wagmi";
import {
  type AccessInfo,
  type AccessRequest,
  accessMessage,
  costSoFar,
  gridMarketAbi,
  isSecureEndpoint,
  parseAccessInfo,
  parseMetadata,
} from "@grid/shared";
import { Button, ErrorText, linkClass, Page, Stat, Status } from "../components/ui";
import { useDeployment } from "../contracts";
import { fmtDate, fmtDuration, fmtEth, shortError } from "../lib/format";
import { useNow } from "../lib/hooks";
import { useFingerprint, useSshKey } from "../lib/sshKey";
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
  const [sshText, setSshText, sshKey] = useSshKey();

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
          <Link href="/direct" className={linkClass}>
            Find a machine
          </Link>
        </p>
      </Page>
    );
  }

  const list = [...(rentals ?? [])].reverse();
  return (
    <Page title="Rentals" lede="Rentals paid for from this wallet. If you end one early, the time you did not use is refunded.">
      {list.some((v) => !v.rental.ended) && <SshKeyField text={sshText} onChange={setSshText} sshKey={sshKey} />}
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
            <Link href="/direct" className={linkClass}>
              Find a machine
            </Link>
          </p>
        ) : (
          list.map((view) => <RentalRow key={view.id.toString()} view={view} sshKey={sshKey} />)
        )}
      </div>
    </Page>
  );
}

function RentalRow({ view, sshKey }: { view: RentalView; sshKey: string | null }) {
  const { id, rental, machine } = view;
  const meta = parseMetadata(machine.metadata);
  const now = useNow();
  const deployment = useDeployment()!;
  const tx = useTx();
  const { signMessageAsync } = useSignMessage();
  const chainId = useChainId();
  const [access, setAccess] = useState<AccessInfo | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  const endsAt = Number(rental.startedAt + rental.paidHours * 3600n);
  const active = !rental.ended;
  const expired = now >= endsAt;
  const cost = active ? costSoFar(rental, now) : null;

  // Proves to the host that this wallet holds the rental and hands it the renter's SSH public key,
  // inside the signed message; the host checks the signature against the renter stored on-chain,
  // lets the key in and replies with the machine's host keys. No password exists.
  async function getAccess() {
    if (!meta) return;
    if (!sshKey) {
      setAccessError("Add your SSH public key above first.");
      return;
    }
    if (!isSecureEndpoint(meta.endpoint)) {
      setAccessError("This host publishes a plain http address, so its reply could be tampered with on the way.");
      return;
    }
    setFetching(true);
    setAccessError(null);
    try {
      const ts = Math.floor(Date.now() / 1000);
      // The message names this chain and market, so the signature is useless anywhere else.
      const sig = await signMessageAsync({
        message: accessMessage({ chainId, market: deployment.GridMarket, rentalId: id, ts, sshKey }),
      });
      const body: AccessRequest = { ts, sig, key: sshKey };
      const res = await fetch(`${meta.endpoint}/access/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
        redirect: "error",
      });
      const text = await res.text();
      if (text.length > 8_000) throw new Error("The host sent an oversized reply.");
      const reply = JSON.parse(text) as { error?: unknown };
      if (!res.ok) {
        const said = typeof reply.error === "string" ? reply.error.replace(/[^\x20-\x7e]/g, "").slice(0, 120) : `status ${res.status}`;
        throw new Error(`The host says: ${said}`);
      }
      const info = parseAccessInfo(reply);
      if (!info) throw new Error("The host sent access details in a form Grid does not accept.");
      setAccess(info);
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
          <Button onClick={getAccess} disabled={fetching || !meta || !sshKey}>
            {fetching ? "Waiting for signature…" : access ? "Refresh SSH access" : "Get SSH access"}
          </Button>
          <Button variant="danger" onClick={end} disabled={!!tx.pending}>
            {tx.pending ?? (expired ? "Settle" : "End rental")}
          </Button>
        </div>
      )}

      {access && active && (
        <div className="mt-4 whitespace-pre-wrap break-all rounded-[3px] bg-plate px-4 py-3 font-mono text-[13px] leading-relaxed">
          <div>
            <span className="select-none text-faint">$ </span>
            {access.command}
          </div>
          {access.hostKeys.map((k) => (
            <HostKey key={k} hostKey={k} />
          ))}
          <div className="text-faint">
            {access.hostKeys.length > 0
              ? "On first connect your SSH client shows the machine's fingerprint; it must match the one above."
              : "This host sent no host key, so check the fingerprint carefully on first connect."}
          </div>
          <div className="text-faint">access ends {fmtDate(access.endsAt)}</div>
        </div>
      )}
      <ErrorText className="mt-3">{accessError}</ErrorText>
      <ErrorText className="mt-3">{tx.error}</ErrorText>
    </div>
  );
}

/** Where the renter gives the SSH public key their rentals let in. */
function SshKeyField({ text, onChange, sshKey }: { text: string; onChange: (v: string) => void; sshKey: string | null }) {
  const fp = useFingerprint(sshKey);
  return (
    <div className="mb-10">
      <label htmlFor="ssh-key" className="engraved text-faint">
        Your SSH public key
      </label>
      <input
        id="ssh-key"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        placeholder="ssh-ed25519 AAAA…  (the contents of ~/.ssh/id_ed25519.pub)"
        className="mt-2 block w-full rounded-[3px] border border-line bg-dial px-3 py-2 font-mono text-[13px] outline-none transition-colors focus:border-steel"
      />
      <p className="mt-2 text-[13px] text-muted">
        {sshKey && fp ? (
          <>
            Rentals will let in <span className="font-mono text-ink">{fp}</span>. Logins are by key only; there is no password.
          </>
        ) : text.trim() ? (
          "That is not an SSH public key. Paste the one line from the .pub file, never the private key."
        ) : (
          <>
            No key yet? Run <code className="rounded-[2px] bg-plate px-1 font-mono">ssh-keygen -t ed25519</code> and paste the contents of{" "}
            <code className="rounded-[2px] bg-plate px-1 font-mono">~/.ssh/id_ed25519.pub</code>.
          </>
        )}
      </p>
    </div>
  );
}

function HostKey({ hostKey }: { hostKey: string }) {
  const fp = useFingerprint(hostKey);
  return (
    <div>
      <span className="select-none text-faint">host key </span>
      {fp ?? "…"}
    </div>
  );
}
