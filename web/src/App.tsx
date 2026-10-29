import { useState } from "react";
import { useChainId, useChains } from "wagmi";
import { Wallet } from "./components/Wallet";
import { Card } from "./components/ui";
import { useDeployment } from "./contracts";
import { Host } from "./pages/Host";
import { Market } from "./pages/Market";
import { Rentals } from "./pages/Rentals";

const tabs = [
  ["market", "Market"],
  ["rentals", "My rentals"],
  ["host", "Host"],
] as const;
type Tab = (typeof tabs)[number][0];

export default function App() {
  const [tab, setTab] = useState<Tab>("market");
  const deployment = useDeployment();
  const chainId = useChainId();
  const chain = useChains().find((c) => c.id === chainId);

  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-800">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
          <div className="text-lg font-semibold tracking-tight">
            Grid <span className="text-sm font-normal text-zinc-500">decentralized compute</span>
          </div>
          <nav className="flex gap-1">
            {tabs.map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`rounded-md px-3 py-1.5 text-sm ${tab === id ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white"}`}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="ml-auto">
            <Wallet />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {!deployment && (
          <Card className="mb-4 border-amber-500/40">
            <p className="text-sm text-amber-200">
              Grid&apos;s contracts are not deployed on {chain?.name ?? `chain ${chainId}`}. Switch chains in the wallet
              menu, or for a local chain run <code className="rounded bg-zinc-800 px-1">npm run deploy:local</code>.
            </p>
          </Card>
        )}
        {tab === "market" && <Market onRented={() => setTab("rentals")} />}
        {tab === "rentals" && <Rentals />}
        {tab === "host" && <Host />}
      </main>

      <footer className="mx-auto max-w-6xl px-4 py-8 text-xs text-zinc-600">
        Listings and payments live on-chain in GridMarket; hosts bond GRID in StakeRegistry; access details come straight
        from each host&apos;s node. No Grid server in between.
      </footer>
    </div>
  );
}
