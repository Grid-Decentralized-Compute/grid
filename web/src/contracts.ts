import { deployments, type Deployment } from "@grid/shared";
import { useChainId } from "wagmi";

/** Contract addresses for the chain the wallet (or the default chain) is on; undefined if not deployed there. */
export function useDeployment(): Deployment | undefined {
  const chainId = useChainId();
  return deployments[chainId];
}
