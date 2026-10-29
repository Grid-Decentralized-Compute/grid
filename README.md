# Grid

Decentralized compute network. Hosts list machines; renters pay ETH into an on-chain escrow on
Robinhood Chain and get SSH access straight from the host; hosts bond GRID to stay listed. No Grid
server sits in between.

This is the v0 skeleton: dedicated per-machine rental, like Vast.ai or RunPod, with the market and
the money on-chain. Swarm jobs (one job spread over many peers) come later on top of the same pieces.

## How it works

1. A host runs `node/` on a machine. It publishes the machine (GPU, RAM, price per hour and the URL
   where the node can be reached) in `GridMarket` and waits.
2. A renter opens `web/`, picks a machine and calls `rent(machineId, hours)`, paying the whole rental
   in ETH. The ETH stays in the contract.
3. The host node sees the rental on-chain, starts an SSH container and hands the renter the login
   once the renter proves with a wallet signature that they hold the rental.
4. Either side ends the rental any time (anyone can, once the paid time is over). The contract pays
   the host for every started minute and refunds the rest. Both pull their ETH with `withdraw()`.
5. Hosts bond GRID in `StakeRegistry` to stay rentable after a 30-day trial. A bond takes 7 days to
   get back and can be burned by the slasher for proven fraud. GRID never pays for compute.

## Layout

| Folder             | What                                                                                                   | Stack              |
| ------------------ | ------------------------------------------------------------------------------------------------------ | ------------------ |
| `contracts/`       | `GridMarket` (listings, ETH escrow, per-minute settlement), `StakeRegistry` (GRID bonds), `MockGRID`   | Foundry            |
| `node/`            | Host daemon: lists the machine, serves `/health` and `/access`, runs the SSH container, settles rentals | Node 22+, viem     |
| `web/`             | Market, My rentals and Host pages; talks to the chain and to host nodes directly                       | Vite, React, wagmi |
| `packages/shared/` | Chain definitions, generated ABIs and addresses, wire types shared by web and node                     | TypeScript         |

## Run it locally

Needs Node 22.22+ and Foundry (`forge`, `anvil`).

```bash
npm install
npm run contracts:test        # Foundry tests
npm run chain                 # terminal 1: local chain (anvil)
npm run deploy:local          # deploys and writes contracts/deployments/31337.json
npm run node                  # terminal 2: host node (set GRID_SIMULATE=1 in node/.env to fake a GPU)
npm run web                   # terminal 3: http://localhost:5173
```

In the web app, "Dev wallet · renter" rents and "Dev wallet · host" shows the host side (bond GRID,
withdraw earnings). Both are anvil's funded accounts, signed by anvil itself; a real wallet such as
MetaMask works through "Connect". `npm run typecheck` checks every TypeScript package.

## Run a real host

```bash
cp node/.env.example node/.env
# set GRID_CHAIN_ID, GRID_PRIVATE_KEY (the host wallet), GRID_PRICE_PER_HOUR,
# and GRID_PUBLIC_URL to where renters can reach port 7777 (port-forward, Tailscale Funnel or a Cloudflare tunnel)
npm run node
```

With an NVIDIA GPU and Docker, each rental gets its own container from `GRID_DOCKER_IMAGE` with
`--gpus all`, SSH on `GRID_SSH_PORT`. Without Docker the node runs in simulated mode.

## Deploy to Robinhood Chain

```bash
npm run deploy:testnet        # asks for the deployer key; writes contracts/deployments/46630.json
npm run contracts:build       # refreshes the generated addresses for web and node
```

Testnet: chain id 46630, faucet at https://faucet.testnet.chain.robinhood.com. Mainnet (4663):
set `GRID_TOKEN` to the GRID address launched through Creora and run the script with
`--rpc-url robinhood`; `MockGRID` is only deployed when `GRID_TOKEN` is unset.

## Adding features

- New on-chain rule: change `contracts/src`, add a test in `contracts/test`, then `npm run contracts:build`
  so `packages/shared/src/generated` picks up the new ABI. The web and node are typed against it.
- New host capability (Jupyter, templates, usage reports): `node/src/sessions.ts` starts what a rental
  gets, `node/src/server.ts` is what renters can ask the node.
- New page or wallet action: `web/src/pages`, with `useTx` for transactions and `useReadContract` for reads.
- New chain: `packages/shared/src/index.ts`.
