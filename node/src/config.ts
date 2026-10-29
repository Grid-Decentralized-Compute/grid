import { resolve } from "node:path";
import { type Address, isAddress, parseEther } from "viem";
import { chainById, deployments, type GridChain, isSecureEndpoint } from "@grid/shared";

export type Config = {
  chain: GridChain;
  rpcUrl: string;
  privateKey: `0x${string}`;
  market: Address;
  stake: Address;
  name: string;
  pricePerHourWei: bigint;
  port: number;
  /**
   * Where renters reach the HTTP API directly. null = behind NAT: the node is reached through a relay's
   * gateway instead, and cannot take direct SSH rentals.
   */
  publicUrl: string | null;
  /** Hostname renters SSH into (defaults to the public URL's host). */
  sshHost: string;
  sshPort: number;
  /** true = fake GPU, no containers; false = require docker; "auto" = use docker when present */
  simulate: boolean | "auto";
  dockerImage: string;
  stateDir: string;
  pollMs: number;
  /** SwarmMarket address, or null when swarm work is off or not deployed on this chain. */
  swarm: Address | null;
  /** Lowest price per run (wei) this host accepts for swarm work. */
  swarmMinPriceWei: bigint;
  /** Tasks claimed per round. */
  swarmBatch: number;
  /** Let swarm containers reach the network (off by default). */
  swarmNetwork: boolean;
  /** Testing only: submit wrong results, to exercise the tie-break. */
  swarmCheat: boolean;
  /** TCP port of the libp2p host. */
  p2pPort: number;
  /** Multiaddrs this node tells peers to dial (public nodes only). */
  p2pAnnounce: string[];
  /** Extra peers to dial at start, as multiaddrs ending in /p2p/<peer id>. */
  p2pBootstrap: string[];
  /** Serve as a relay: forward circuits for NAT'd peers and their HTTP through /p2p/<peer>. */
  relay: boolean;
  /** Address the HTTP API listens on; 127.0.0.1 when it is only reached through a local tunnel. */
  bindHost: string;
  /** Dial and accept peers on private networks (local testing only). */
  allowPrivatePeers: boolean;
  /** Hours a swarm job's outputs are kept for renters to fetch before they are deleted. */
  swarmKeepHours: number;
};

/** anvil account #1 — the default host on a local chain (account #0 deploys, #2 and #3 are the web's dev wallets). */
const ANVIL_HOST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== "") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing ${name}: set it in node/.env (see node/env.example)`);
}

export function loadConfig(): Config {
  const chainId = Number(env("GRID_CHAIN_ID", "31337"));
  const chain = chainById(chainId);
  if (!chain) throw new Error(`Unknown GRID_CHAIN_ID ${chainId}; known: 31337 (anvil), 46630 (Robinhood testnet), 4663 (Robinhood)`);

  const deployment = deployments[chainId];
  const market = process.env.GRID_MARKET_ADDRESS || deployment?.GridMarket;
  const stake = process.env.GRID_STAKE_ADDRESS || deployment?.StakeRegistry;
  if (!market || !stake || !isAddress(market) || !isAddress(stake)) {
    throw new Error(
      `No contract addresses for chain ${chainId}: run "npm run deploy:local" (or deploy:testnet) or set GRID_MARKET_ADDRESS and GRID_STAKE_ADDRESS`,
    );
  }

  const port = Number(env("GRID_PORT", "7777"));
  // Unset means "behind NAT" on a real chain; a local chain defaults to this machine. "none" forces NAT mode.
  const rawPublic = env("GRID_PUBLIC_URL", chainId === 31337 ? `http://127.0.0.1:${port}` : "none");
  const publicUrl = rawPublic === "none" ? null : rawPublic.replace(/\/+$/, "");
  let url: URL | null = null;
  if (publicUrl) {
    try {
      url = new URL(publicUrl);
    } catch {
      throw new Error(`GRID_PUBLIC_URL is not a URL: ${publicUrl}`);
    }
  }
  // Renters hand over their SSH key and get the host keys over this URL, and a web app served over https cannot even
  // call an http:// host, so outside local development the endpoint has to be https.
  if (publicUrl && !isSecureEndpoint(publicUrl) && chainId !== 31337 && process.env.GRID_ALLOW_HTTP !== "1") {
    throw new Error(
      `GRID_PUBLIC_URL must be https:// (put a Cloudflare tunnel, Tailscale Funnel or a reverse proxy with a certificate in front of port ${port}); set GRID_ALLOW_HTTP=1 only to accept that access requests travel unencrypted`,
    );
  }

  const p2pPort = Number(env("GRID_P2P_PORT", "4001"));
  const relay = process.env.GRID_RELAY === "1";
  if (relay && !publicUrl) throw new Error("GRID_RELAY=1 needs GRID_PUBLIC_URL: a relay must be reachable to forward for others");

  const simulateEnv = process.env.GRID_SIMULATE;
  const simulate: Config["simulate"] =
    simulateEnv === undefined || simulateEnv === "" ? "auto" : simulateEnv === "1" || simulateEnv === "true";

  return {
    chain,
    rpcUrl: env("GRID_RPC_URL", chain.rpcUrls.default.http[0]),
    privateKey: env("GRID_PRIVATE_KEY", chainId === 31337 ? ANVIL_HOST_KEY : undefined) as `0x${string}`,
    market,
    stake,
    // Never the computer's hostname by default: it is published on-chain and often carries a name.
    name: env("GRID_NAME", "grid-host"),
    pricePerHourWei: parseEther(env("GRID_PRICE_PER_HOUR", "0.001")),
    port,
    publicUrl,
    sshHost: env("GRID_SSH_HOST", url?.hostname ?? ""),
    sshPort: Number(env("GRID_SSH_PORT", "2222")),
    simulate,
    dockerImage: env("GRID_DOCKER_IMAGE", "lscr.io/linuxserver/openssh-server:latest"),
    stateDir: resolve(env("GRID_STATE_DIR", ".grid")),
    pollMs: Number(env("GRID_POLL_SECONDS", "5")) * 1000,
    swarm: swarmAddress(deployment?.SwarmMarket),
    swarmMinPriceWei: parseEther(env("GRID_SWARM_MIN_PRICE", "0")),
    swarmBatch: Math.min(32, Math.max(1, Number(env("GRID_SWARM_BATCH", "4")))),
    swarmNetwork: process.env.GRID_SWARM_NETWORK === "1",
    swarmCheat: process.env.GRID_SWARM_CHEAT === "1",
    p2pPort,
    p2pAnnounce: list(process.env.GRID_P2P_ANNOUNCE) ?? (url ? [announceFor(url.hostname, p2pPort)] : []),
    p2pBootstrap: list(process.env.GRID_BOOTSTRAP) ?? [],
    relay,
    bindHost: env("GRID_BIND", "0.0.0.0"),
    allowPrivatePeers: chainId === 31337 || process.env.GRID_ALLOW_PRIVATE_PEERS === "1",
    swarmKeepHours: Math.max(1, Number(env("GRID_SWARM_KEEP_HOURS", "72"))),
  };
}

const list = (value: string | undefined) =>
  value ? value.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

/** /ip4/1.2.3.4/tcp/4001 for an address, /dns4/host/tcp/4001 for a name. */
function announceFor(host: string, port: number) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? `/ip4/${host}/tcp/${port}` : `/dns4/${host}/tcp/${port}`;
}

/** Swarm work is on by default wherever SwarmMarket is deployed; GRID_SWARM=0 turns it off. */
function swarmAddress(fromDeployment: string | undefined): Address | null {
  if (process.env.GRID_SWARM === "0") return null;
  const address = process.env.GRID_SWARM_ADDRESS || fromDeployment;
  return address && isAddress(address) ? address : null;
}
