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
   * served over https cannot call an http:// host at all. A node behind NAT publishes its relay's
   * gateway, <relay>/p2p/<peer id>.
   */
  endpoint: string;
  /** libp2p identity of the node, and whether it can take direct SSH rentals (false behind NAT). */
  p2p?: { peer: string; addrs: string[]; relay: boolean; direct: boolean };
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
    p2p: parseP2p(o.p2p),
  };
}

function parseP2p(v: unknown): MachineMetadata["p2p"] {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.peer !== "string" || !PEER_ID.test(o.peer)) return undefined;
  // Only well-formed TCP multiaddrs: a malformed one would make every node that dials it throw.
  const addrs = Array.isArray(o.addrs)
    ? o.addrs.filter((a): a is string => typeof a === "string" && a.length <= 200 && PEER_ADDR.test(a)).slice(0, 8)
    : [];
  return { peer: o.peer, addrs, relay: o.relay === true, direct: o.direct !== false };
}

const PEER_ID = /^[1-9A-HJ-NP-Za-km-z]{40,64}$/;
const PEER_ADDR = /^\/(ip4|ip6|dns4|dns6|dns)\/[A-Za-z0-9.:\-]{1,253}\/tcp\/\d{1,5}(\/p2p\/[1-9A-HJ-NP-Za-km-z]{40,64})?$/;

/**
 * Whether a host name or IP literal points into a private, loopback, link-local or otherwise
 * non-public network. Endpoints and peer addresses come from strangers' listings; following them
 * there would let a listing probe the machine's own network (SSRF).
 */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/) ?? h.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (h.includes(":")) {
    return h === "::" || h === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h) || h.startsWith("::ffff:");
  }
  return false;
}

/**
 * The model alone, as people say it: "NVIDIA GeForce RTX 4090" → "RTX 4090", "NVIDIA A100-SXM4-80GB"
 * → "A100", "NVIDIA H100 80GB HBM3" → "H100". Memory is shown beside it, so it is dropped from the
 * name. Machines without a GPU are "CPU only".
 */
export function gpuModel(meta: MachineMetadata | null): string {
  if (!meta) return "Unknown";
  if (meta.gpuCount === 0 || !meta.gpu.trim()) return "CPU only";
  const name = meta.gpu
    .replace(/^(NVIDIA|AMD|Intel)\s+/i, "")
    .replace(/^(GeForce|Radeon)\s+/i, "")
    .replace(/[-\s](SXM\d*|PCIe|NVL|HBM\d*e?|\d+\s?GB)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return name || meta.gpu.trim();
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

/**
 * The message a renter signs to prove to a host that they hold a rental. It names the chain and
 * the market, so a signature made for one deployment can never be replayed against another.
 */
export const accessMessage = (a: { chainId: number; market: string; rentalId: bigint | number | string; ts: number }) =>
  `grid-access\nchain:${a.chainId}\nmarket:${a.market.toLowerCase()}\nrental:${a.rentalId}\nts:${a.ts}`;

/** How long a signed access message stays valid, in seconds, either side of the host's clock. */
export const ACCESS_MESSAGE_TTL_SECONDS = 120;

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

/**
 * Checks a host's reply to POST /access field by field. The host is a stranger: only a plain host
 * name or IP, a port, a Unix user name and a printable password are accepted, and the SSH command
 * is rebuilt from them (see sshCommand) instead of taken from the reply, so a host cannot slip
 * options such as ProxyCommand into what a person or an agent runs.
 */
export function parseAccessInfo(raw: unknown): AccessInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const ok =
    typeof o.host === "string" && /^[A-Za-z0-9.:-]{1,253}$/.test(o.host) && !o.host.startsWith("-") &&
    Number.isInteger(o.port) && (o.port as number) >= 1 && (o.port as number) <= 65535 &&
    typeof o.user === "string" && /^[a-z_][a-z0-9_-]{0,31}$/.test(o.user) &&
    typeof o.password === "string" && /^[\x21-\x7e]{1,128}$/.test(o.password) &&
    Number.isInteger(o.endsAt);
  if (!ok) return null;
  const a = { rentalId: String(o.rentalId ?? ""), host: o.host as string, port: o.port as number, user: o.user as string, password: o.password as string, endsAt: o.endsAt as number };
  return { ...a, command: sshCommand(a) };
}

/** The SSH command for a rental, built only from validated fields. */
export const sshCommand = (a: { host: string; port: number; user: string }) =>
  `ssh -p ${a.port} ${a.user}@${a.host.includes(":") ? `[${a.host}]` : a.host}`;

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

// ---------------------------------------------------------------- peer-to-peer network

/** libp2p protocols and topics Grid nodes speak. */
export const P2P_HTTP_PROTOCOL = "/grid/http/1.0.0";
export const P2P_DHT_PROTOCOL = "/grid/kad/1.0.0";
export const P2P_HEARTBEAT_TOPIC = "grid/heartbeat/1";
/** How often nodes announce themselves, and how long an announcement counts as "online". */
export const HEARTBEAT_SECONDS = 15;
export const HEARTBEAT_TTL_SECONDS = 60;

/**
 * What a node gossips every HEARTBEAT_SECONDS, signed by its host wallet so the libp2p peer is
 * bound to an on-chain identity. `sig` must stay the last field: it signs everything before it.
 */
export type PeerHeartbeat = {
  v: 1;
  peer: string;
  host: `0x${string}`;
  name: string;
  /** Where renters reach this node: its own URL, a relay's /p2p/<peer> gateway, or null. */
  endpoint: string | null;
  /** Set when this node relays for others: its public URL. */
  relay: string | null;
  /** True when the node can take direct SSH rentals (it has a public address). */
  direct: boolean;
  busy: boolean;
  ts: number;
  sig: `0x${string}`;
};

export const heartbeatMessage = (h: Omit<PeerHeartbeat, "sig">) => `grid-heartbeat\n${JSON.stringify(h)}`;

/** Reply of GET <endpoint>/peers on a relay: the peers it has heard from recently. */
export type PeersInfo = { peers: (Omit<PeerHeartbeat, "sig"> & { seen: number })[]; self: string };
