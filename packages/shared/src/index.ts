import { defineChain } from "viem";

export * from "./generated/abi";
export * from "./generated/deployments";

const eth = { name: "Ether", symbol: "ETH", decimals: 18 } as const;

/** Local Foundry chain for development (`npm run chain`). */
export const anvil = defineChain({
  id: 31337,
  name: "Anvil (local)",
  nativeCurrency: eth,
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: eth,
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://explorer.testnet.chain.robinhood.com" } },
  testnet: true,
});

export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: eth,
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

export const chains = [anvil, robinhoodTestnet, robinhood] as const;
export type GridChain = (typeof chains)[number];
export const chainById = (id: number): GridChain | undefined => chains.find((c) => c.id === id);

/** Everywhere except Robinhood Chain mainnet the GRID token is a mintable stand-in (MockGRID). */
export const isTestToken = (chainId: number) => chainId !== robinhood.id;

/** Mirrors GridMarket.TRIAL_PERIOD: how long a host can be rented without a GRID bond. */
export const TRIAL_PERIOD_SECONDS = 30 * 24 * 3600;
/** Mirrors GridMarket.TRIAL_MAX_DEPOSIT: the most ETH one rental may hold while the host is unbonded. */
export const TRIAL_MAX_DEPOSIT_WEI = 10_000_000_000_000_000n; // 0.01 ETH
/** Mirrors GridMarket.MAX_METADATA: the longest metadata string a listing may carry. */
export const MAX_METADATA_BYTES = 1024;

/** What a host publishes on-chain about a machine (GridMarket.Machine.metadata, as JSON). */
export type MachineMetadata = {
  v: 1;
  name: string;
  gpu: string;
  vramGb: number;
  gpuCount: number;
  cpu: string;
  ramGb: number;
  diskGb: number;
  os: string;
  /**
   * Base URL of the host node's HTTP API, e.g. https://gpu.example.com. It must be https://
   * (plain http:// only on localhost): renters fetch their SSH password over it, and a web app
   * served over https cannot call an http:// host at all.
   */
  endpoint: string;
};

/**
 * Reads a listing's metadata defensively. It is free text written by whoever listed the
 * machine, so every field is type-checked and clipped before a page renders it.
 */
export function parseMetadata(json: string): MachineMetadata | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null; // not JSON: a listing made by hand or by an older node
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const str = (key: string, max = 120) => (typeof o[key] === "string" ? (o[key] as string).slice(0, max) : "");
  const num = (key: string) => {
    const v = o[key];
    return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
  };
  const endpoint = str("endpoint", 300);
  if (!endpoint) return null;
  return {
    v: 1,
    name: str("name"),
    gpu: str("gpu"),
    vramGb: num("vramGb"),
    gpuCount: num("gpuCount"),
    cpu: str("cpu"),
    ramGb: num("ramGb"),
    diskGb: num("diskGb"),
    os: str("os"),
    endpoint,
  };
}

/** Loopback addresses may use plain http (local development). */
export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/** Whether renters may talk to this endpoint at all: https, or http on a loopback address. */
export function isSecureEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname));
  } catch {
    return false;
  }
}

/** The message a renter signs to prove to a host that they hold a rental. */
export const accessMessage = (rentalId: bigint | number | string, timestamp: number) =>
  `grid-access:${rentalId}:${timestamp}`;

/** How long a signed access message stays valid, in seconds. */
export const ACCESS_MESSAGE_TTL_SECONDS = 300;

/** Body of POST <endpoint>/access/:rentalId */
export type AccessRequest = { ts: number; sig: `0x${string}` };

/** Reply of POST <endpoint>/access/:rentalId once the rental's container is up. */
export type AccessInfo = {
  rentalId: string;
  host: string;
  port: number;
  user: string;
  password: string;
  command: string;
  endsAt: number;
};

/** Reply of GET <endpoint>/health. */
export type HealthInfo = {
  ok: true;
  machineId: string;
  name: string;
  busy: boolean;
  mode: "docker" | "simulated";
  now: number;
  version: string;
};

/**
 * Mirrors GridMarket.endRental: the host is paid for every started minute of
 * the paid window, never more than the deposit.
 */
export function costSoFar(
  rental: { startedAt: bigint; paidHours: bigint; pricePerHour: bigint; deposit: bigint },
  nowSeconds: number,
): bigint {
  const maxSeconds = rental.paidHours * 3600n;
  let elapsed = BigInt(Math.max(0, Math.floor(nowSeconds) - Number(rental.startedAt)));
  if (elapsed > maxSeconds) elapsed = maxSeconds;
  let minutes = (elapsed + 59n) / 60n;
  if (minutes === 0n) minutes = 1n;
  const cost = (rental.pricePerHour * minutes) / 60n;
  return cost > rental.deposit ? rental.deposit : cost;
}
