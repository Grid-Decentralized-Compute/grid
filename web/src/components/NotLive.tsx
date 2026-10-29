import { useChainId, useChains } from "wagmi";
import { Link } from "../router";
import { linkClass } from "./ui";

/** Shown wherever the contracts are not deployed on the selected chain. */
export function NotLive() {
  const chainId = useChainId();
  const chain = useChains().find((c) => c.id === chainId);
  return (
    <p className="py-8 text-muted">
      Grid is not deployed on {chain?.name ?? "this network"} yet. The testnet deployment is the next step.{" "}
      <Link href="/about" className={linkClass}>
        Where it stands
      </Link>
    </p>
  );
}
