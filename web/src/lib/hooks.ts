import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useReadContract } from "wagmi";
import { gridMarketAbi, type HealthInfo, isPrivateHost, isSecureEndpoint, parseMetadata, type PeersInfo } from "@grid/shared";
import { useDeployment } from "../contracts";

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
 * only call https (or loopback) endpoints, and the access request (signed key, host keys) travels over that call.
 */
export function endpointBlocked(endpoint: string | undefined): boolean {
  if (!endpoint) return false;
  if (isLocalDev()) return !isSecureEndpoint(endpoint);
  // On the public site a listing may not point visitors' browsers at their own network.
  try {
    if (isPrivateHost(new URL(endpoint).hostname)) return true;
  } catch {
    return true;
  }
  return !endpoint.startsWith("https://");
}

/** Plain-http endpoints are tolerated while the app itself runs on localhost. */
function isLocalDev(): boolean {
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h.endsWith(".localhost");
}

/**
 * Pings a host node's /health. Success means the node is reachable from this browser. Shared by
 * each market row and the GPU index, which react-query runs as one request per node.
 */
export const healthQuery = (endpoint: string | undefined) => ({
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

export function useHealth(endpoint: string | undefined) {
  return useQuery(healthQuery(endpoint));
}

/**
 * Peers online, as heard by any relay listed on-chain. Relays gossip with every node, so one of
 * them is enough; the first that answers is used.
 */
export function usePeers() {
  const deployment = useDeployment();
  const { data: listings } = useReadContract({
    abi: gridMarketAbi,
    address: deployment?.GridMarket,
    functionName: "getListings",
    args: [0n, 100n],
    query: { enabled: !!deployment, refetchInterval: 30_000 },
  });
  const relays = (listings ?? [])
    .map(({ machine }) => parseMetadata(machine.metadata))
    .filter((m) => m?.p2p?.relay && m.endpoint && !endpointBlocked(m.endpoint))
    .map((m) => m!.endpoint);
  return useQuery({
    queryKey: ["peers", relays.join(",")],
    enabled: relays.length > 0,
    refetchInterval: 15_000,
    retry: false,
    queryFn: async (): Promise<PeersInfo | null> => {
      for (const relay of relays) {
        try {
          const res = await fetch(`${relay}/peers`, { signal: AbortSignal.timeout(4_000), redirect: "error" });
          // A relay is a stranger: only a well-formed list is used, so a bad one cannot break the page.
          const data = res.ok ? ((await res.json()) as Partial<PeersInfo>) : null;
          if (data && Array.isArray(data.peers) && typeof data.self === "string") {
            const peers = data.peers
              .filter((p) => p && typeof p.name === "string" && typeof p.peer === "string")
              .slice(0, 200)
              .map((p) => ({ ...p, name: p.name.slice(0, 64) }));
            return { self: data.self.slice(0, 64), peers };
          }
        } catch {
          // try the next relay
        }
      }
      return null;
    },
  });
}
