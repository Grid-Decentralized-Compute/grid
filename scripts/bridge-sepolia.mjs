// Moves Sepolia ETH onto Robinhood Chain testnet through the chain's own deposit contract, for the
// deployer key in contracts/.env (or any key in PRIVATE_KEY). An address is the same on both chains,
// so the ETH lands at the same address on the testnet about ten minutes later.
//
//   node scripts/bridge-sepolia.mjs              shows balances and what would be sent
//   node scripts/bridge-sepolia.mjs --send       sends all but a small reserve for Sepolia gas
//   node scripts/bridge-sepolia.mjs --send 0.05  sends exactly 0.05 ETH
//
// Addresses from Robinhood's published testnet config (chain 46630, parent chain Sepolia 11155111):
// https://cdn.robinhood.com/assets/generated_assets/hoodchain_docsite/chain-node-configs/robinhood-chain-testnet-config.json
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const INBOX = "0xF2939afA86F6f933A3CE17fCAB007907B6b0B7a4";
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const TESTNET_RPC = "https://rpc.testnet.chain.robinhood.com";
/** Left on Sepolia to pay for the deposit transaction itself. */
const RESERVE = parseEther("0.003");

const testnet = defineChain({
  id: 46630,
  name: "Robinhood Chain testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [TESTNET_RPC] } },
});
const inboxAbi = [{ type: "function", name: "depositEth", stateMutability: "payable", inputs: [], outputs: [{ type: "uint256" }] }];

function deployerKey() {
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY;
  const env = readFileSync(new URL("../contracts/.env", import.meta.url), "utf8");
  const line = env.split(/\r?\n/).find((l) => l.startsWith("PRIVATE_KEY="));
  if (!line) throw new Error("No PRIVATE_KEY in contracts/.env");
  return line.slice("PRIVATE_KEY=".length).trim();
}

const account = privateKeyToAccount(deployerKey());
const l1 = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
const l2 = createPublicClient({ chain: testnet, transport: http(TESTNET_RPC) });

const [onSepolia, onTestnet] = await Promise.all([
  l1.getBalance({ address: account.address }),
  l2.getBalance({ address: account.address }),
]);
console.log(`address           ${account.address}`);
console.log(`on Sepolia        ${formatEther(onSepolia)} ETH`);
console.log(`on Robinhood test ${formatEther(onTestnet)} ETH`);

const args = process.argv.slice(2);
const send = args.includes("--send");
const asked = args.find((a) => /^\d+(\.\d+)?$/.test(a));
const amount = asked ? parseEther(asked) : onSepolia > RESERVE ? onSepolia - RESERVE : 0n;
if (amount <= 0n || amount + RESERVE > onSepolia) {
  console.log(`nothing to bridge: needs more than ${formatEther(RESERVE)} ETH on Sepolia`);
  process.exit(asked ? 1 : 0);
}
if (!send) {
  console.log(`would bridge      ${formatEther(amount)} ETH (run again with --send)`);
  process.exit(0);
}

const wallet = createWalletClient({ account, chain: sepolia, transport: http(SEPOLIA_RPC) });
const hash = await wallet.writeContract({ address: INBOX, abi: inboxAbi, functionName: "depositEth", value: amount });
console.log(`deposit sent      ${hash}`);
const receipt = await l1.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error("the deposit transaction reverted on Sepolia");
console.log(`confirmed on Sepolia in block ${receipt.blockNumber}; waiting for it on the testnet…`);

// The chain credits the deposit after it reads the Sepolia block, usually within ten minutes.
const target = onTestnet + amount;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 20_000));
  const now = await l2.getBalance({ address: account.address });
  if (now >= target) {
    console.log(`arrived           ${formatEther(now)} ETH on Robinhood testnet`);
    process.exit(0);
  }
}
console.log("not credited after 20 minutes; check the address on the testnet explorer");
process.exit(1);
