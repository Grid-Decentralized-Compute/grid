import { useState } from "react";
import { parseEther } from "viem";
import { useAccount, useChainId, useReadContract } from "wagmi";
import { erc20Abi, gridMarketAbi, isTestToken, parseMetadata, stakeRegistryAbi, TRIAL_PERIOD_SECONDS } from "@grid/shared";
import { SOURCE_URL } from "../lib/links";
import { Button, ErrorText, Input, linkClass, Note, Page, Section, Stat, Status } from "../components/ui";
import { useDeployment } from "../contracts";
import { fmtDate, fmtEth, fmtGrid } from "../lib/format";
import { useNow } from "../lib/hooks";
import { useTx } from "../lib/useTx";



export function Host() {
  const deployment = useDeployment();
  const { address } = useAccount();

  return (
    <Page title="Host" lede="Run the node on a machine you own to list it. Earnings accrue for each minute it is rented and can be withdrawn at any time. The contract takes no fee.">
      {!address ? (
        <Section title="Your machines">
          <p className="text-muted">Connect the wallet your node runs with to see its machines, earnings and bond.</p>
        </Section>
      ) : !deployment ? (
        <Section title="Your machines">
          <p className="text-muted">No machines listed from this wallet. Start a node below and it appears here.</p>
        </Section>
      ) : (
        <Dashboard address={address} />
      )}
      <RunANode />
    </Page>
  );
}

function Dashboard({ address }: { address: `0x${string}` }) {
  const deployment = useDeployment()!;
  const chainId = useChainId();
  const now = useNow();
  const tx = useTx();
  const [amount, setAmount] = useState("100");

  const query = { refetchInterval: 5_000 };
  const token = { abi: erc20Abi, address: deployment.GRID } as const;
  const stake = { abi: stakeRegistryAbi, address: deployment.StakeRegistry } as const;
  const market = { abi: gridMarketAbi, address: deployment.GridMarket } as const;

  const { data: gridBalance } = useReadContract({ ...token, functionName: "balanceOf", args: [address], query });
  const { data: bonded } = useReadContract({ ...stake, functionName: "bonded", args: [address], query });
  const { data: minBond } = useReadContract({ ...stake, functionName: "minBond" });
  const { data: unbond } = useReadContract({ ...stake, functionName: "unbonds", args: [address], query });
  const { data: hostSince } = useReadContract({ ...market, functionName: "hostSince", args: [address], query });
  const { data: eligible } = useReadContract({ ...market, functionName: "hostEligible", args: [address], query });
  const { data: machines } = useReadContract({ ...market, functionName: "getMachinesOf", args: [address], query });
  const { data: earnings } = useReadContract({ ...market, functionName: "balances", args: [address], query });

  let wei = 0n;
  try {
    wei = parseEther(amount || "0");
  } catch {
    wei = 0n;
  }
  // minBond == 0 means bonding is switched off: nobody is "bonded" and nothing expires.
  const bondingOff = minBond === 0n;
  const isBonded = !bondingOff && minBond !== undefined && bonded !== undefined && bonded >= minBond;
  const trialEndsAt = hostSince && hostSince !== 0n ? Number(hostSince) + TRIAL_PERIOD_SECONDS : null;
  const [pendingUnbond, claimableAt] = unbond ?? [0n, 0n];
  const unbondReady = pendingUnbond > 0n && Number(claimableAt) <= now;

  const bondState: [Parameters<typeof Status>[0]["tone"], string] | null =
    eligible === undefined
      ? null
      : bondingOff
        ? ["ok", "Not required yet"]
        : isBonded
          ? ["ok", "Bonded"]
          : eligible
            ? ["busy", `Trial until ${trialEndsAt ? fmtDate(trialEndsAt) : "—"}`]
            : trialEndsAt
              ? ["bad", "Trial over: bond to stay listed"]
              : ["off", "No machines listed yet"];

  const write = tx.write;
  const bond = () =>
    tx.run("Bonding…", [
      () => write({ ...token, functionName: "approve", args: [deployment.StakeRegistry, wei] }),
      () => write({ ...stake, functionName: "bond", args: [wei] }),
    ]);
  const startUnbond = () => tx.run("Unbonding…", [() => write({ ...stake, functionName: "startUnbond", args: [wei] })]);
  const withdrawUnbond = () => tx.run("Withdrawing…", [() => write({ ...stake, functionName: "withdraw" })]);
  const withdrawEarnings = () => tx.run("Withdrawing…", [() => write({ ...market, functionName: "withdraw" })]);
  const mint = () =>
    tx.run("Minting…", [() => write({ ...token, functionName: "mint", args: [address, parseEther("1000")] })]);

  return (
    <>
      <Section
        title="Your machines"
        aside={
          earnings !== undefined &&
          earnings > 0n && (
            <Button onClick={withdrawEarnings} disabled={!!tx.pending}>
              Withdraw {fmtEth(earnings)} ETH
            </Button>
          )
        }
      >
        {!machines || machines.length === 0 ? (
          <p className="text-muted">No machines listed from this wallet. Start a node below and it appears here.</p>
        ) : (
          <ul className="-mt-2">
            {machines.map(({ id, machine, rentable }) => {
              const meta = parseMetadata(machine.metadata);
              return (
                <li key={id.toString()} className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-line py-3 last:border-0">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{meta?.name || `Machine ${id}`}</span>
                    <span className="text-muted"> · {meta && meta.gpuCount > 0 ? meta.gpu : "No GPU"}</span>
                  </span>
                  <span className="tnum font-mono text-[13px] text-muted">{fmtEth(machine.pricePerHour)} ETH/h</span>
                  <Status tone={machine.activeRental !== 0n ? "busy" : rentable ? "ok" : "off"}>
                    {machine.activeRental !== 0n ? "Rented" : rentable ? "Listed" : machine.available ? "Not rentable" : "Paused"}
                  </Status>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Bond" aside={bondState && <Status tone={bondState[0]}>{bondState[1]}</Status>}>
        <Note className="max-w-[62ch]">
          {bondingOff
            ? "Bonding is not switched on for this network yet, so every host can be rented."
            : "After 30 days a host keeps GRID locked to stay listed. It cannot be withdrawn while one of your rentals runs, takes 7 days to come back, and is only burned if you are proven to have cheated a renter. Until you bond, each rental is capped at 0.01 ETH."}
        </Note>
        <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Stat label="In wallet">{gridBalance !== undefined ? `${fmtGrid(gridBalance)} GRID` : "…"}</Stat>
          <Stat label="Bonded">{bonded !== undefined ? `${fmtGrid(bonded)} GRID` : "…"}</Stat>
          <Stat label="Required">{minBond !== undefined ? `${fmtGrid(minBond)} GRID` : "…"}</Stat>
          <Stat label="Unbonding">
            {pendingUnbond > 0n ? `${fmtGrid(pendingUnbond)} · ${unbondReady ? "ready" : fmtDate(claimableAt)}` : "—"}
          </Stat>
        </dl>
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} className="w-28" aria-label="Amount of GRID" />
          <Button onClick={bond} disabled={!!tx.pending || wei === 0n}>
            {tx.pending === "Bonding…" ? tx.pending : "Bond"}
          </Button>
          <Button variant="secondary" onClick={startUnbond} disabled={!!tx.pending || wei === 0n}>
            Unbond
          </Button>
          {unbondReady && (
            <Button variant="secondary" onClick={withdrawUnbond} disabled={!!tx.pending}>
              Withdraw {fmtGrid(pendingUnbond)} GRID
            </Button>
          )}
          {isTestToken(chainId) && (
            <Button variant="quiet" className="ml-2" onClick={mint} disabled={!!tx.pending}>
              Get 1,000 test GRID
            </Button>
          )}
        </div>
        <ErrorText className="mt-3">{tx.error}</ErrorText>
      </Section>
    </>
  );
}

function RunANode() {
  return (
    <Section title="Run a node">
      <Note className="max-w-[62ch]">On the machine with the GPU, from a copy of the source:</Note>
      <pre className="mt-4 overflow-x-auto rounded-[3px] bg-plate px-4 py-3 font-mono text-[13px] leading-relaxed">
        <span className="select-none text-faint">$ </span>npm install{"\n"}
        <span className="select-none text-faint">$ </span>cp node/env.example node/.env{"\n"}
        <span className="select-none text-faint">$ </span>npm run node
      </pre>
      <Note className="mt-4 max-w-[62ch]">
        In <span className="font-mono text-[12px] text-ink">.env</span>, set the wallet, the hourly price and the https
        address renters reach the node at. With Docker and the NVIDIA Container Toolkit each rental gets its own GPU
        container. The full steps are in the{" "}
        <a className={linkClass} href={`${SOURCE_URL}#run-a-real-host`}>
          README
        </a>
        .
      </Note>
    </Section>
  );
}
