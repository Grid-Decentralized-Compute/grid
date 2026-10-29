# Grid

Decentralized compute network. Hosts list machines; renters pay ETH into an on-chain escrow on
Robinhood Chain and get SSH access straight from the host; hosts bond GRID to stay listed. No Grid
server sits in between.

This is the v0 skeleton: dedicated per-machine rental, like Vast.ai or RunPod, with the market and
the money on-chain. Swarm jobs (one job spread over many peers) come later on top of the same pieces.

## How it works

1. A host runs `node/` on a machine. It publishes the machine (GPU, RAM, price per hour and the
   https URL where the node can be reached) in `GridMarket` and waits.
2. A renter opens `web/`, picks a machine and calls `rent(machineId, hours)`, paying the whole rental
   in ETH. The ETH stays in the contract.
3. The host node sees the rental on-chain, starts an SSH container and hands the renter the login
   once the renter proves with a wallet signature that they hold the rental.
4. Either side ends the rental any time (anyone can, once the paid time is over). The contract pays
   the host for every started minute and refunds the rest. Both pull their ETH with `withdraw()`.
5. Hosts bond GRID in `StakeRegistry` to stay rentable after a 30-day trial, during which each rental
   is capped at 0.01 ETH. A bond cannot be withdrawn while one of the host's rentals runs, takes 7
   days to come back, and can be burned by the slasher for proven fraud. GRID never pays for compute.
   While `minBond` is 0 (the default off a local chain) bonding is switched off and every host is
   rentable.

## Layout

| Folder             | What                                                                                                   | Stack              |
| ------------------ | ------------------------------------------------------------------------------------------------------ | ------------------ |
| `contracts/`       | `GridMarket` (listings, ETH escrow, per-minute settlement), `StakeRegistry` (GRID bonds), `MockGRID`   | Foundry            |
| `node/`            | Host daemon: lists the machine, serves `/health` and `/access`, runs the SSH container, settles rentals | Node 22+, viem     |
| `web/`             | The whole site at one URL: market (/), rentals, host, about; talks to the chain and host nodes only   | Vite, React, wagmi |
| `packages/shared/` | Chain definitions, generated ABIs and addresses, wire types shared by web and node                     | TypeScript         |

`packages/shared/src/generated/` is committed so a checkout without Foundry can still type-check,
build the web and run the node; `npm run contracts:build` regenerates it after a contract change.

## Run it locally

Needs Node 22.22+ and Foundry (`forge`, `anvil`). Clone with `--recurse-submodules` (forge-std is a
submodule), or run `git submodule update --init` afterwards.

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
cp node/env.example node/.env
# set GRID_CHAIN_ID, GRID_PRIVATE_KEY (the host wallet), GRID_PRICE_PER_HOUR,
# GRID_PUBLIC_URL (https) and GRID_SSH_HOST / GRID_SSH_PORT (see below)
npm run node
```

Two things must be reachable from the internet:

- **The HTTP API on `GRID_PORT`** (7777), published as `GRID_PUBLIC_URL`. It must be `https://`:
  renters fetch their SSH password over it, and the web app, served over https, cannot call an
  http:// host at all. A Cloudflare Tunnel or a Tailscale Funnel in front of port 7777 gives you
  that; `GRID_ALLOW_HTTP=1` disables the check for experiments only.
- **The SSH port `GRID_SSH_PORT`** (2222) as raw TCP on `GRID_SSH_HOST`. HTTPS tunnels do not carry
  it: forward the port on your router (set `GRID_SSH_HOST` to your public IP or a DNS name), or use
  a Tailscale Funnel TCP route and set `GRID_SSH_PORT` to the port it exposes.

With an NVIDIA GPU and Docker, each rental gets its own container from `GRID_DOCKER_IMAGE` with
`--gpus all`, SSH on `GRID_SSH_PORT`. On Linux that needs the NVIDIA Container Toolkit
(`nvidia-container-toolkit`, then `sudo nvidia-ctk runtime configure --runtime=docker` and restart
Docker); the node checks it at startup. Without Docker the node runs in simulated mode. Stopping the
node leaves a running rental's container up and marks the machine unavailable; the node adopts the
container again when it comes back, and after three failed container starts it ends the rental so
the renter is refunded.

## Deploy to Robinhood Chain

```bash
# contracts/.env: PRIVATE_KEY=0x...   (a deployer wallet; fund it at https://faucet.testnet.chain.robinhood.com)
npm run deploy:testnet        # writes contracts/deployments/46630.json and refreshes packages/shared
```

Testnet is chain id 46630. For mainnet (4663) also set `GRID_TOKEN` to the GRID address launched
through Creora and run `npm run deploy:mainnet`; `MockGRID` is only deployed when `GRID_TOKEN` is
unset. `MIN_BOND` (GRID wei) sets the bond requirement; it defaults to 0 off a local chain until the
real token exists and the registry is audited.

## Adding features

- New on-chain rule: change `contracts/src`, add a test in `contracts/test`, then `npm run contracts:build`
  so `packages/shared/src/generated` picks up the new ABI. The web and node are typed against it.
- New host capability (Jupyter, templates, usage reports): `node/src/sessions.ts` starts what a rental
  gets, `node/src/server.ts` is what renters can ask the node.
- New page or wallet action: `web/src/pages`, with `useTx` for transactions and `useReadContract` for reads.
- New chain: `packages/shared/src/index.ts`.

## License

MIT. See [LICENSE](LICENSE).
