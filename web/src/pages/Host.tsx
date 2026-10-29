import { useState } from "react";
import { parseEther } from "viem";
import { useAccount, useChainId, useReadContract } from "wagmi";
import { erc20Abi, gridMarketAbi, isTestToken, parseMetadata, stakeRegistryAbi, TRIAL_PERIOD_SECONDS } from "@grid/shared";
import { Badge, Button, Card, ErrorText, Input, Muted, Stat } from "../components/ui";
import { useDeployment } from "../contracts";
import { fmtDate, fmtEth, fmtGrid } from "../lib/format";
import { useNow } from "../lib/hooks";
import { useTx } from "../lib/useTx";

export function Host() {
  const deployment = useDeployment();
  const { address } = useAccount();
  const chainId = useChainId();
  const now = useNow();
  const tx = useTx();
  const [amount, setAmount] = useState("100");

  const enabled = !!deployment && !!address;
  const query = { enabled, refetchInterval: 5_000 };
  const token = { abi: erc20Abi, address: deployment?.GRID } as const;
  const stake = { abi: stakeRegistryAbi, address: deployment?.StakeRegistry } as const;
  const market = { abi: gridMarketAbi, address: deployment?.GridMarket } as const;

  const { data: gridBalance } = useReadContract({ ...token, functionName: "balanceOf", args: [address!], query });
  const { data: bonded } = useReadContract({ ...stake, functionName: "bonded", args: [address!], query });
  const { data: minBond } = useReadContract({ ...stake, functionName: "minBond", query: { enabled: !!deployment } });
  const { data: unbond } = useReadContract({ ...stake, functionName: "unbonds", args: [address!], query });
  const { data: hostSince } = useReadContract({ ...market, functionName: "hostSince", args: [address!], query });
  const { data: eligible } = useReadContract({ ...market, functionName: "hostEligible", args: [address!], query });
  const { data: machines } = useReadContract({ ...market, functionName: "getMachinesOf", args: [address!], query });
  const { data: earnings } = useReadContract({ ...market, functionName: "balances", args: [address!], query });

  if (!deployment) return null;
  if (!address) {
    return (
      <Card>
        <Muted>Connect the wallet your host node runs with to manage its bond and earnings.</Muted>
      </Card>
    );
  }

  let wei = 0n;
  try {
    wei = parseEther(amount || "0");
  } catch {
    wei = 0n;
  }
  const isBonded = minBond !== undefined && bonded !== undefined && bonded >= minBond;
  const trialEndsAt = hostSince && hostSince !== 0n ? Number(hostSince) + TRIAL_PERIOD_SECONDS : null;
  const [pendingUnbond, claimableAt] = unbond ?? [0n, 0n];

  const bond = () =>
    tx.run("Bonding…", [
      () => tx.write({ ...token, address: deployment.GRID, functionName: "approve", args: [deployment.StakeRegistry, wei] }),
      () => tx.write({ ...stake, address: deployment.StakeRegistry, functionName: "bond", args: [wei] }),
    ]);
  const startUnbond = () =>
    tx.run("Unbonding…", [
      () => tx.write({ ...stake, address: deployment.StakeRegistry, functionName: "startUnbond", args: [wei] }),
    ]);
  const withdrawUnbond = () =>
    tx.run("Withdrawing GRID…", [
      () => tx.write({ ...stake, address: deployment.StakeRegistry, functionName: "withdraw" }),
    ]);
  const withdrawEarnings = () =>
    tx.run("Withdrawing ETH…", [
      () => tx.write({ ...market, address: deployment.GridMarket, functionName: "withdraw" }),
    ]);
  const mint = () =>
    tx.run("Minting…", [
      () => tx.write({ ...token, address: deployment.GRID, functionName: "mint", args: [address, parseEther("1000")] }),
    ]);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Host</h1>

      <Card className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">Your GRID bond</h2>
          {eligible === undefined ? null : isBonded ? (
            <Badge tone="good">bonded — rentable</Badge>
          ) : eligible ? (
            <Badge tone="warn">trial until {trialEndsAt ? fmtDate(trialEndsAt) : "—"}</Badge>
          ) : trialEndsAt ? (
            <Badge tone="bad">trial over — bond to be rentable</Badge>
          ) : (
            <Badge>not listed yet</Badge>
          )}
        </div>
        <Muted>
          Hosts lock GRID to list. The bond is never spent on anything: it waits 7 days to come back and a share of it
          is burned only if you are proven to have cheated a renter. Your first 30 days need no bond.
        </Muted>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="GRID in wallet" value={gridBalance !== undefined ? fmtGrid(gridBalance) : "…"} />
          <Stat label="Bonded" value={bonded !== undefined ? fmtGrid(bonded) : "…"} />
          <Stat label="Minimum" value={minBond !== undefined ? fmtGrid(minBond) : "…"} />
          <Stat
            label="Unbonding"
            value={pendingUnbond > 0n ? `${fmtGrid(pendingUnbond)} · ${Number(claimableAt) <= now ? "ready" : fmtDate(claimableAt)}` : "—"}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} className="w-32" placeholder="GRID" />
          <Button onClick={bond} disabled={!!tx.pending || wei === 0n}>
            {tx.pending === "Bonding…" ? tx.pending : "Bond"}
          </Button>
          <Button variant="secondary" onClick={startUnbond} disabled={!!tx.pending || wei === 0n}>
            Unbond
          </Button>
          {pendingUnbond > 0n && Number(claimableAt) <= now && (
            <Button variant="secondary" onClick={withdrawUnbond} disabled={!!tx.pending}>
              Withdraw {fmtGrid(pendingUnbond)} GRID
            </Button>
          )}
          {isTestToken(chainId) && (
            <Button variant="secondary" onClick={mint} disabled={!!tx.pending}>
              Get 1000 test GRID
            </Button>
          )}
        </div>
        <ErrorText>{tx.error}</ErrorText>
      </Card>

      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">Your machines</h2>
          {earnings !== undefined && earnings > 0n && (
            <Button onClick={withdrawEarnings} disabled={!!tx.pending}>
              Withdraw {fmtEth(earnings)} ETH earned
            </Button>
          )}
        </div>
        {!machines || machines.length === 0 ? (
          <Muted>No machines listed from this wallet yet.</Muted>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {machines.map(({ id, machine, rentable }) => {
              const meta = parseMetadata(machine.metadata);
              return (
                <li key={id.toString()} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span>
                    <span className="font-medium">{meta?.name ?? `Machine #${id}`}</span>{" "}
                    <span className="text-zinc-500">#{id.toString()}</span>
                    {meta && <span className="text-zinc-400"> · {meta.gpuCount > 0 ? meta.gpu : "CPU only"}</span>}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-zinc-400">{fmtEth(machine.pricePerHour)} ETH/h</span>
                    {machine.activeRental !== 0n ? (
                      <Badge tone="good">rented</Badge>
                    ) : rentable ? (
                      <Badge>idle</Badge>
                    ) : (
                      <Badge tone="warn">{machine.available ? "not rentable" : "paused"}</Badge>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card className="space-y-2">
        <h2 className="font-medium">Run a node</h2>
        <Muted>
          The node lists this machine, waits for rentals, starts an SSH container for the renter and settles the rental
          on-chain. Nothing is sent through Grid: renters reach your node directly at the URL you publish.
        </Muted>
        <pre className="overflow-x-auto rounded-md bg-zinc-950 p-3 text-xs text-zinc-300">
          {`cp node/.env.example node/.env   # set GRID_PRIVATE_KEY to this wallet and GRID_PUBLIC_URL to where renters reach you
npm run node`}
        </pre>
      </Card>
    </div>
  );
}
