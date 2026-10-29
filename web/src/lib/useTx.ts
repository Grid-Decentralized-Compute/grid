import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { usePublicClient, useWriteContract } from "wagmi";
import { shortError } from "./format";

/**
 * Runs one or more transactions in order, waits for each receipt, then refreshes
 * every on-chain read on the page. Pages only need `run`, `pending` and `error`.
 */
export function useTx() {
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(label: string, steps: Array<() => Promise<`0x${string}`>>): Promise<boolean> {
    if (!client) return false;
    setError(null);
    setPending(label);
    try {
      for (const step of steps) {
        const hash = await step();
        await client.waitForTransactionReceipt({ hash });
      }
      await queryClient.invalidateQueries();
      return true;
    } catch (e) {
      setError(shortError(e));
      return false;
    } finally {
      setPending(null);
    }
  }

  return { run, pending, error, write: writeContractAsync };
}
