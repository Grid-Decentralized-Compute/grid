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
  const { data: balance } = useBalance({ address, query: { refetchInterval: 15_000 } });

  if (!isConnected || !address) {
    const browserWallet = connectors.find((c) => c.id !== "mock");
    // Mock connectors all share the id "mock"; their order matches devWallets.
    const mocks = connectors.filter((c) => c.id === "mock");
    const message = error
      ? /provider not found|ProviderNotFound/i.test(`${error.name} ${error.message}`)
        ? "No wallet in this browser"
        : shortError(error)
      : null;
    return (
      <div className="flex items-center gap-4">
        {message && <span className="hidden text-[12px] text-bad md:inline">{message}</span>}
        {mocks.map((connector, i) => (
          <Button key={connector.uid} variant="quiet" className="text-[13px]" onClick={() => connect({ connector })}>
            {devWallets[i]?.label ?? "Dev wallet"}
          </Button>
        ))}
        {browserWallet && (
          <Button disabled={isPending} onClick={() => connect({ connector: browserWallet })}>
            Connect wallet
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-4 text-[13px]">
      <select
        aria-label="Network"
        className="hidden cursor-pointer appearance-none bg-transparent text-muted outline-none [field-sizing:content] hover:text-ink sm:block"
        value={chainId}
        onChange={(e) => switchChain({ chainId: Number(e.target.value) as (typeof chains)[number]["id"] })}
      >
        {chains.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {balance && <span className="tnum hidden font-mono text-muted md:inline">{fmtEth(balance.value, 4)} ETH</span>}
      <span className="font-mono" title={address}>
        {shortAddr(address)}
      </span>
      <Button variant="quiet" onClick={() => disconnect()}>
        Disconnect
      </Button>
    </div>
  );
}
