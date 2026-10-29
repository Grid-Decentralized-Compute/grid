import { defineChain, hexToString, keccak256, stringToHex, toBytes } from "viem";

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

// ---------------------------------------------------------------- swarm jobs

/** Runs escrowed per task in SwarmMarket: two replicas and one tie-break. */
export const SWARM_RUNS = 3;
/** Mirrors SwarmMarket.MAX_MANIFEST. */
export const MAX_MANIFEST_BYTES = 64 * 1024;
/** Mirrors SwarmMarket.MAX_BATCH. */
export const SWARM_MAX_BATCH = 32;
/** The most output a host keeps and serves for one task. */
export const MAX_OUTPUT_BYTES = 1_000_000;

/** Mirrors SwarmMarket.STATUS_*. */
export const TaskStatus = { Waiting: 0, Running: 1, Partial: 2, Disputed: 3, Done: 4, Failed: 5 } as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

/**
 * What a renter publishes with a swarm job. It is emitted in SwarmMarket.JobPosted, so it is
 * public: task inputs must not contain anything secret.
 */
export type SwarmManifest = {
  v: 1;
  /** Container image, e.g. python:3.12-slim. Pin a digest for reproducible results. */
  image: string;
  /** Run with `sh -c` inside the container; the task's input arrives on stdin, its output is stdout. */
  command: string;
  /** Ask for a GPU (hosts without one skip the job). */
  gpu?: boolean;
  /** One input per task. */
  tasks: string[];
};

export const encodeManifest = (manifest: SwarmManifest): `0x${string}` => stringToHex(JSON.stringify(manifest));

export function parseManifest(hex: `0x${string}`): SwarmManifest | null {
  try {
    const v = JSON.parse(hexToString(hex));
    if (
      v &&
      typeof v.image === "string" &&
      typeof v.command === "string" &&
      Array.isArray(v.tasks) &&
      v.tasks.every((t: unknown) => typeof t === "string")
    ) {
      return { v: 1, image: v.image, command: v.command, gpu: v.gpu === true, tasks: v.tasks };
    }
  } catch {
    // not a manifest this version understands
  }
  return null;
}

/** The result a host submits for a task: keccak256 of the exact output bytes. */
export const resultHash = (output: string): `0x${string}` => keccak256(toBytes(output));

/** Where a host serves the output of a task it ran. */
export const resultUrl = (endpoint: string, swarm: string, jobId: bigint | number, task: number) =>
  `${endpoint.replace(/\/+$/, "")}/results/${swarm.toLowerCase()}/${jobId}/${task}`;
