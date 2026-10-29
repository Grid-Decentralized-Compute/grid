import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { TransactionReceipt } from "viem";
import { useAccount, useChainId, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { shortError } from "./format";

/**
 * Runs one or more transactions in order on the app's chain, waits for each receipt,
 * fails on a revert, then refreshes every on-chain read on the page. Pages only need
 * `run`, `write`, `pending` and `error`.
 */
export function useTx() {
  const { writeContractAsync } = useWriteContract();
  const chainId = useChainId();
  const { chainId: walletChainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const client = usePublicClient();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Runs the steps in order; resolves to their receipts, or null when any step failed. */
  async function run(label: string, steps: Array<() => Promise<`0x${string}`>>): Promise<TransactionReceipt[] | null> {
    if (!client) return null;
    const receipts: TransactionReceipt[] = [];
    setError(null);
    setPending(label);
    try {
      // The page reads from the app's chain; a wallet sitting on another network is switched, never used as is.
      if (walletChainId !== undefined && walletChainId !== chainId) await switchChainAsync({ chainId });
      for (const step of steps) {
        const hash = await step();
        const receipt = await client.waitForTransactionReceipt({ hash });
        if (receipt.status === "reverted") throw new Error(`Transaction reverted on-chain (${hash.slice(0, 10)}…)`);
        receipts.push(receipt);
      }
      await queryClient.invalidateQueries();
      return receipts;
    } catch (e) {
      setError(shortError(e));
      return null;
    } finally {
      setPending(null);
    }
  }

  // Every write names the app's chain so wagmi refuses to send it anywhere else.
  type WriteArgs = Parameters<typeof writeContractAsync>[0];
  const write = ((args: WriteArgs) => writeContractAsync({ ...args, chainId } as WriteArgs)) as typeof writeContractAsync;

  return { run, pending, error, write };
}
