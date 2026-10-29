# Node configuration

The node reads these settings from its environment or from `node/.env` (start from `node/env.example`). Every one has a default that works on a local chain.

## Chain and wallet

| Setting | Default | Description |
| --- | --- | --- |
| `GRID_CHAIN_ID` | `31337` | `31337` local, `46630` Robinhood Chain testnet, `4663` Robinhood Chain |
| `GRID_RPC_URL` | chain's public RPC | RPC endpoint |
| `GRID_PRIVATE_KEY` | local test key | The host wallet: lists the machine, receives the ETH. Required off a local chain |
| `GRID_MARKET_ADDRESS`, `GRID_STAKE_ADDRESS`, `GRID_SWARM_ADDRESS` | from `contracts/deployments` | Override contract addresses |

## Listing and direct rentals

| Setting | Default | Description |
| --- | --- | --- |
| `GRID_NAME` | hostname | Name shown in the market |
| `GRID_PRICE_PER_HOUR` | `0.001` | ETH per hour |
| `GRID_PORT` | `7777` | Port of the node's HTTP API |
| `GRID_PUBLIC_URL` | unset | Where renters reach the API; must be https off a local chain. Unset (or `none`) means behind a router: reached through a relay, swarm only |
| `GRID_ALLOW_HTTP` | unset | `1` accepts a plain http `GRID_PUBLIC_URL`. For experiments only |
| `GRID_SSH_HOST` | host of `GRID_PUBLIC_URL` | Where renters SSH in |
| `GRID_SSH_PORT` | `2222` | SSH port mapped to the rental container |
| `GRID_DOCKER_IMAGE` | `lscr.io/linuxserver/openssh-server:latest` | Image for direct-rental containers |
| `GRID_SIMULATE` | auto | `1` runs without Docker or a GPU, for trying the market. Unset detects both |

## Swarm

| Setting | Default | Description |
| --- | --- | --- |
| `GRID_SWARM` | on | `0` keeps the node out of the swarm |
| `GRID_SWARM_MIN_PRICE` | `0` | Lowest ETH per run to accept |
| `GRID_SWARM_BATCH` | `4` | Tasks claimed per round, 1 to 32 |
| `GRID_SWARM_NETWORK` | off | `1` lets task containers reach the network |
| `GRID_SWARM_CHEAT` | off | `1` submits wrong results, to test tie-breaks on a local chain. Never use it elsewhere |

## Network

| Setting | Default | Description |
| --- | --- | --- |
| `GRID_P2P_PORT` | `4001` | TCP port for libp2p |
| `GRID_P2P_ANNOUNCE` | derived from `GRID_PUBLIC_URL` | Comma-separated multiaddrs other peers should dial |
| `GRID_BOOTSTRAP` | none | Comma-separated multiaddrs ending in `/p2p/<peer id>`, dialled besides the peers listed on-chain |
| `GRID_RELAY` | off | `1` makes this node a relay for peers behind routers. Needs `GRID_PUBLIC_URL` |

## Housekeeping

| Setting | Default | Description |
| --- | --- | --- |
| `GRID_STATE_DIR` | `.grid` | Machine id, peer key and swarm outputs |
| `GRID_POLL_SECONDS` | `5` | Seconds between chain checks |
