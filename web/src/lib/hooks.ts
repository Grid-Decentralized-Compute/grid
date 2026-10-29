import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { HealthInfo } from "@grid/shared";

/** Current unix time (seconds), re-rendering every `intervalMs`. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Pings a host node's /health. Success means the node is reachable from this browser. */
export function useHealth(endpoint: string | undefined) {
  return useQuery({
    queryKey: ["health", endpoint],
    enabled: !!endpoint,
    refetchInterval: 15_000,
    retry: false,
    queryFn: async (): Promise<HealthInfo> => {
      const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`health check failed: ${res.status}`);
      return res.json();
    },
  });
}
