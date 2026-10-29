# Running a node

The node is the program a host runs next to its GPU. It lists the machine, serves direct rentals, works for the swarm between rentals, and joins the peer-to-peer network.

## Requirements

* Node.js 22.22 or newer.
* A wallet with a little ETH on Robinhood Chain for transactions.
* Docker. On Linux, the NVIDIA Container Toolkit to pass GPUs into containers (`nvidia-ctk runtime configure --runtime=docker`, then restart Docker). The node checks this at startup.
* For direct rentals: an https address for the node's API and a reachable SSH port. Without them the node still works for the swarm through a relay.

## Quick setup on Ubuntu

On Ubuntu 22.04 or 24.04 with an NVIDIA driver 570 or newer, one script does the rest: it installs Docker, the NVIDIA Container Toolkit, Node.js and cloudflared, builds the rental image and checks the GPU works inside it, writes `node/.env` with a new host wallet, and installs the node as a systemd service.

```bash
curl -fsSLo host-setup.sh https://raw.githubusercontent.com/Grid-Decentralized-Compute/grid/main/scripts/host-setup.sh
less host-setup.sh          # read it first
GRID_PUBLIC_URL=https://node1.example.com bash host-setup.sh
```

The node runs as its own `grid` system user from `/opt/grid` under a locked-down systemd service, never as your account. Renters' containers get their own docker network, and firewall rules (restored at every boot) stop them reaching your LAN, your router or the machine itself. The script refuses an NVIDIA Container Toolkit older than 1.17.8, which has public container-escape bugs, and turns on automatic security updates. Set `GRID_REF` to a tag or commit to run exactly a version you have reviewed. It is safe to run again. Its settings and every step are described at the top of [`scripts/host-setup.sh`](https://github.com/Grid-Decentralized-Compute/grid/blob/main/scripts/host-setup.sh).

## Start by hand

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

A Cloudflare Tunnel or a Tailscale Funnel in front of port 7777 gives a home machine an https address. SSH and the peer-to-peer port are raw TCP, which such a tunnel does not carry: forward 2222 and 4001 on your router, and set `GRID_SSH_HOST` to your public IP and `GRID_P2P_ANNOUNCE` to `/ip4/<public IP>/tcp/4001`. Otherwise both are derived from `GRID_PUBLIC_URL`, which points at the tunnel.

## GPU rentals need a CUDA image

Renters log in to a container started from `GRID_DOCKER_IMAGE`. The default, `linuxserver/openssh-server`, is built on Alpine Linux, which cannot run `nvidia-smi` or CUDA programs. On a GPU host, build the image in `node/rental-image` (Ubuntu 24.04, CUDA 12.8 with cuDNN, Python, SSH on 2222) and use it:

```bash
docker build -t grid-rental node/rental-image
# node/.env
GRID_DOCKER_IMAGE=grid-rental
```

At startup the node runs `nvidia-smi` inside the rental image and refuses to list the machine if the GPU does not work there.

## What the node does

* **Direct rental:** starts a container from `GRID_DOCKER_IMAGE` with `--gpus all`, hands the renter an SSH login, and settles on-chain when the paid time is up. Stopping the node leaves a running rental's container up; the node adopts it again when it returns.
* **Swarm:** while the machine is not rented, claims small batches of tasks, runs each in a throwaway container with no network, keeps the output and submits its hash.
* **Network:** keeps libp2p connections to other nodes and announces itself every 15 seconds.

## Bond and earnings

For the first 30 days a host needs no bond, but each direct rental is capped at 0.01 ETH. After that, and for swarm work whenever bonding is on, the host keeps GRID bonded in `StakeRegistry`. A bond cannot be withdrawn while one of the host's rentals is running, and takes seven days to come back. Earnings from both markets accrue in the contracts and are collected from the **Host** page.
