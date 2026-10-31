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
| `GRID_NAME` | `grid-host` | Name shown in the market. It is published on-chain, so it never defaults to the computer's hostname |
| `GRID_PRICE_PER_HOUR` | `0.001` | ETH per hour |
| `GRID_PORT` | `7777` | Port of the node's HTTP API |
| `GRID_BIND` | `0.0.0.0` | Address the API listens on. `127.0.0.1` when it is only reached through a local tunnel (the setup script sets this) |
| `GRID_PUBLIC_URL` | unset | Where renters reach the API; must be https off a local chain. Unset (or `none`) means behind a router: reached through a relay, swarm only |
| `GRID_ALLOW_HTTP` | unset | `1` accepts a plain http `GRID_PUBLIC_URL`. For experiments only |
| `GRID_SSH_HOST` | host of `GRID_PUBLIC_URL` | Where renters SSH in |
| `GRID_SSH_PORT` | `2222` | SSH port mapped to the rental container |
| `GRID_DOCKER_IMAGE` | `lscr.io/linuxserver/openssh-server:latest` | Image for direct-rental containers. GPU hosts need a CUDA image: build `node/rental-image` and set `grid-rental` |
| `GRID_SIMULATE` | auto | `1` runs without Docker or a GPU, for trying the market. Unset detects both |

## Swarm

| Setting | Default | Description |
| --- | --- | --- |
| `GRID_SWARM` | on | `0` keeps the node out of the swarm |
| `GRID_SWARM_MIN_PRICE` | `0` | Lowest ETH per run to accept |
| `GRID_SWARM_BATCH` | `4` | Tasks claimed per round, 1 to 32 |
| `GRID_SWARM_NETWORK` | off | `1` lets task containers reach the network, including this machine's LAN. Leave it off unless you trust the jobs |
| `GRID_SWARM_KEEP_HOURS` | `72` | Hours a swarm job's outputs are kept for renters to fetch before they are deleted |
| `GRID_SWARM_CHEAT` | off | `1` submits wrong results, to test tie-breaks on a local chain. Never use it elsewhere |

## Availability

Off unless you set it. Outside the window the node claims no new swarm tasks (tasks it already claimed finish, and their results are still committed and revealed) and marks the listing unavailable to new rentals. A rental that is already running is never cut short. The node checks once a minute.

| Setting | Default | Description |
| --- | --- | --- |
| `GRID_HOURS` | unset (always) | Hours the machine is on offer, on a 24-hour clock in the machine's local time: `23-08` or `22:30-07:00`. The end is not included. A window may run past midnight and then belongs to the day it starts on |
| `GRID_DAYS` | unset (all days) | Days the window applies to: `mon-fri`, `sat,sun`, `mon-wed,fri`, `fri-mon`, or `all`. With `GRID_HOURS=23-08` and `mon-fri` the machine is on offer from Friday 23:00 until Saturday 08:00. Without `GRID_HOURS` it means whole days |

Times follow the machine's clock. To use another time zone, set `TZ` (for example `TZ=Europe/Berlin` in `node/.env`).

The listing is only reopened when the node itself would list it open, so a node behind a router (swarm only) never opens its listing, and neither does a node that gave up on a rental until it restarts.

## Self-pricing

Off unless `GRID_AUTO_PRICE=1`. While the machine has had no rental for a full hour, the rental price on the listing is lowered by `GRID_PRICE_STEP` percent of itself, once for every further idle hour, never below `GRID_PRICE_FLOOR`. When a rental starts, the price goes back to `GRID_PRICE_PER_HOUR` for the next renter. Each change is one transaction, sent only when the price really changes, and it does not affect a running rental. The swarm minimum price works the same way in memory, with no transaction: it drops while no swarm task has been claimed for an hour and returns to `GRID_SWARM_MIN_PRICE` when one is claimed.

Only time the machine is actually on offer counts as idle: hours outside `GRID_HOURS` and `GRID_DAYS`, and hours during a rental, do not lower the price. A restart starts the count again, at the full price.

| Setting | Default | Description |
| --- | --- | --- |
| `GRID_AUTO_PRICE` | off | `1` turns self-pricing on |
| `GRID_PRICE_STEP` | `3` | Percent taken off per idle hour, 0 to 100 |
| `GRID_PRICE_FLOOR` | half of `GRID_PRICE_PER_HOUR` | Lowest ETH per hour for a direct rental |
| `GRID_SWARM_MIN_PRICE_FLOOR` | half of `GRID_SWARM_MIN_PRICE` | Lowest ETH per run to accept for swarm work |

## Network

| Setting | Default | Description |
| --- | --- | --- |
| `GRID_P2P_PORT` | `4001` | TCP port for libp2p |
| `GRID_P2P_ANNOUNCE` | derived from `GRID_PUBLIC_URL` | Comma-separated multiaddrs other peers should dial |
| `GRID_BOOTSTRAP` | none | Comma-separated multiaddrs ending in `/p2p/<peer id>`, dialled besides the peers listed on-chain |
| `GRID_RELAY` | off | `1` makes this node a relay for peers behind routers. Needs `GRID_PUBLIC_URL` |
| `GRID_ALLOW_PRIVATE_PEERS` | off | `1` lets the node dial peers on private networks. Always on for a local Anvil chain; leave it off elsewhere |

## Housekeeping

| Setting | Default | Description |
| --- | --- | --- |
| `GRID_STATE_DIR` | `.grid` | Machine id, peer key and swarm outputs |
| `GRID_POLL_SECONDS` | `5` | Seconds between chain checks |
