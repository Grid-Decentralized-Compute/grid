import { hostname } from "node:os";
import { resolve } from "node:path";
import { type Address, isAddress, parseEther } from "viem";
import { chainById, deployments, type GridChain } from "@grid/shared";

export type Config = {
  chain: GridChain;
  rpcUrl: string;
  privateKey: `0x${string}`;
  market: Address;
  stake: Address;
  name: string;
  pricePerHourWei: bigint;
  port: number;
  publicUrl: string;
  /** true = fake GPU, no containers; false = require docker; "auto" = use docker when present */
  simulate: boolean | "auto";
  dockerImage: string;
  sshPort: number;
  stateDir: string;
  pollMs: number;
};

/** anvil account #1 — the default host on a local chain (account #0 deploys, #2 and #3 are the web's dev wallets). */
const ANVIL_HOST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== "") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing ${name}: set it in node/.env (see node/.env.example)`);
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
  const simulateEnv = process.env.GRID_SIMULATE;
  const simulate: Config["simulate"] =
    simulateEnv === undefined || simulateEnv === "" ? "auto" : simulateEnv === "1" || simulateEnv === "true";

  return {
    chain,
    rpcUrl: env("GRID_RPC_URL", chain.rpcUrls.default.http[0]),
    privateKey: env("GRID_PRIVATE_KEY", chainId === 31337 ? ANVIL_HOST_KEY : undefined) as `0x${string}`,
    market,
    stake,
    name: env("GRID_NAME", hostname()),
    pricePerHourWei: parseEther(env("GRID_PRICE_PER_HOUR", "0.001")),
    port,
    publicUrl: env("GRID_PUBLIC_URL", `http://127.0.0.1:${port}`).replace(/\/+$/, ""),
    simulate,
    dockerImage: env("GRID_DOCKER_IMAGE", "lscr.io/linuxserver/openssh-server:latest"),
    sshPort: Number(env("GRID_SSH_PORT", "2222")),
    stateDir: resolve(env("GRID_STATE_DIR", ".grid")),
    pollMs: Number(env("GRID_POLL_SECONDS", "5")) * 1000,
  };
}
