import { useAccount, useBalance, useChainId, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { fmtEth, shortAddr, shortError } from "../lib/format";
import { devWallets } from "../wagmi";
import { Button } from "./ui";

export function Wallet() {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { chains, switchChain } = useSwitchChain();
  const chainId = useChainId();
  const { data: balance } = useBalance({ address, query: { refetchInterval: 10_000 } });

  if (!isConnected || !address) {
    // Mock connectors all share the id "mock"; their order matches devWallets.
    const mocks = connectors.filter((c) => c.id === "mock");
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        {connectors.map((connector) => (
          <Button
            key={connector.uid}
            variant={connector.id === "mock" ? "secondary" : "primary"}
            disabled={isPending}
            onClick={() => connect({ connector })}
          >
            {connector.id === "mock"
              ? (devWallets[mocks.findIndex((c) => c.uid === connector.uid)]?.label ?? "Dev wallet")
              : `Connect ${connector.name}`}
          </Button>
        ))}
        {error && <span className="text-xs text-red-400">{shortError(error)}</span>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 text-sm">
      <select
        className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5"
        value={chainId}
        onChange={(e) => switchChain({ chainId: Number(e.target.value) as (typeof chains)[number]["id"] })}
      >
        {chains.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <span className="text-zinc-400">{balance ? `${fmtEth(balance.value, 4)} ETH` : ""}</span>
      <span className="font-mono" title={address}>
        {shortAddr(address)}
      </span>
      <Button variant="secondary" onClick={() => disconnect()}>
        Disconnect
      </Button>
    </div>
  );
}
