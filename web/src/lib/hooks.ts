import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type HealthInfo, isSecureEndpoint } from "@grid/shared";

/** Current unix time (seconds), re-rendering every `intervalMs`. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * True when this page could not talk to the host at all: a page served over https may
 * only call https (or loopback) endpoints, and the SSH password travels over that call.
 */
export function endpointBlocked(endpoint: string | undefined): boolean {
  if (!endpoint) return false;
  if (window.location.protocol !== "https:") return isSecureEndpoint(endpoint) ? false : !isLocalDev();
  return !isSecureEndpoint(endpoint);
}

/** Plain-http endpoints are tolerated while the app itself runs on localhost. */
function isLocalDev(): boolean {
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h.endsWith(".localhost");
}

/** Pings a host node's /health. Success means the node is reachable from this browser. */
export function useHealth(endpoint: string | undefined) {
  return useQuery({
    queryKey: ["health", endpoint],
    enabled: !!endpoint && !endpointBlocked(endpoint),
    refetchInterval: 15_000,
    retry: false,
    queryFn: async (): Promise<HealthInfo> => {
      const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`health check failed: ${res.status}`);
      return res.json();
    },
  });
}
