# Running a node

The node is the program a host runs next to its GPU. It lists the machine, serves direct rentals, works for the swarm between rentals, and joins the peer-to-peer network.

## Requirements

* Node.js 22.22 or newer.
* A wallet with a little ETH on Robinhood Chain for transactions.
* Docker. On Linux, the NVIDIA Container Toolkit to pass GPUs into containers (`nvidia-ctk runtime configure --runtime=docker`, then restart Docker). The node checks this at startup.
* For direct rentals: an https address for the node's API and a reachable SSH port. Without them the node still works for the swarm through a relay.

## Start

```bash
git clone https://github.com/Grid-Decentralized-Compute/grid
cd grid && npm install
cp node/env.example node/.env     # set the wallet, price and addresses
npm run node
```

Every setting is described in [Node configuration](../reference/config.md).

## Public or relayed

| | With `GRID_PUBLIC_URL` | Without it |
| --- | --- | --- |
| Reached by renters | Directly, at that address | Through a relay's `/p2p/<peer id>` gateway |
| Direct rentals | Yes | No (listed as Swarm only) |
| Swarm work | Yes | Yes |
| Can relay for others | With `GRID_RELAY=1` | No |

A Cloudflare Tunnel or a Tailscale Funnel in front of port 7777 gives a home machine an https address. SSH is raw TCP, so it needs a port forward on your router (or a Tailscale Funnel TCP route) and `GRID_SSH_HOST` set to your public IP or DNS name.

## What the node does

* **Direct rental:** starts a container from `GRID_DOCKER_IMAGE` with `--gpus all`, hands the renter an SSH login, and settles on-chain when the paid time is up. Stopping the node leaves a running rental's container up; the node adopts it again when it returns.
* **Swarm:** while the machine is not rented, claims small batches of tasks, runs each in a throwaway container with no network, keeps the output and submits its hash.
* **Network:** keeps libp2p connections to other nodes and announces itself every 15 seconds.

## Bond and earnings

For the first 30 days a host needs no bond, but each direct rental is capped at 0.01 ETH. After that, and for swarm work whenever bonding is on, the host keeps GRID bonded in `StakeRegistry`. A bond cannot be withdrawn while one of the host's rentals is running, and takes seven days to come back. Earnings from both markets accrue in the contracts and are collected from the **Host** page.
