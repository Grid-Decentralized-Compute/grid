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

## Several GPUs in one machine

A machine with several cards runs one host per card. Each host has its own wallet, listing and bond, takes one GPU and an equal part of the machine's memory and CPU, and works independently of the others. The cards can then be rented one by one, and for swarm work each card is a host of its own, with its own bond at stake.

Put `{n}` in the address and the same script sets up every card:

```bash
GRID_PUBLIC_URL='https://rig1-{n}.example.com' bash host-setup.sh
```

On a machine with six cards this gives `rig1-1` to `rig1-6`, one host each, all served by a single tunnel. Keep `{n}` in the first label of the name (`rig1-{n}.example.com`, not `gpu{n}.rig1.example.com`): Cloudflare's free certificate covers one level of subdomain.

| | Host *n* |
| --- | --- |
| Settings | `/opt/grid/node/hosts/<n>.env` |
| Service | `grid-node@<n>` |
| API | port 7776 + *n* on loopback, reached through the tunnel |
| Renters' SSH | port 2221 + *n* |
| Peer to peer | port 4000 + *n* |

* **One card each.** A host is tied to its card by the card's UUID (`GRID_GPU`). Its containers see that card and no other, and it keeps pointing at the same card when another one is moved or removed.
* **A fair share.** `GRID_SHARE` is set to the number of hosts. Each host gives its containers that share of the memory and CPU and lists that share of the RAM and disk, which is what a renter gets. Size the machine's RAM for it: a job that loads a model needs about the model's size in RAM, on every card at once.
* **A wallet each.** Every host wallet needs test ETH and, where bonding is on, its own bond. The script prints the addresses. To use wallets prepared in advance, pass `GRID_KEYS_FILE`, a file with one key per line (host *n* takes line *n*); it is deleted once the keys are stored.
* **Fewer hosts.** `GRID_HOSTS=3` sets up only the first three cards.
* **Swarm only.** `GRID_DIRECT=0` keeps the hosts out of direct rentals. Nothing needs forwarding on the router then, and the machine's IP address is not published. For direct rentals, forward the SSH and peer-to-peer ports of every host.
* **Your Cloudflare login stays home.** Create the tunnel and its DNS records on your own computer and pass the tunnel's credentials file as `GRID_TUNNEL_CREDENTIALS`. The machine then holds the credentials of that one tunnel and nothing else.

Follow one host with `journalctl -u grid-node@3 -f`, or all of them with `journalctl -u 'grid-node*' -f`.

## Windows (WSL2)

Most gaming PCs run Windows. One PowerShell script turns such a PC into a Grid host: it installs WSL2 and Ubuntu 24.04, then runs [`scripts/host-setup.sh`](https://github.com/Grid-Decentralized-Compute/grid/blob/main/scripts/host-setup.sh) inside Ubuntu from a fresh clone of the repository, so the node, Docker and the NVIDIA Container Toolkit end up set up exactly as on a Linux machine. The NVIDIA driver stays on Windows. WSL2 passes the GPU through to Ubuntu, and no Linux driver is installed. Docker Desktop is not used.

This installer is new and has not been run end to end on a real gaming PC yet. If a step fails, the message says which one, and running the script again continues from there.

You need Windows 11 (or Windows 10 22H2, build 19045 or newer), an NVIDIA driver 570 or newer installed on Windows, virtualization switched on in the BIOS or UEFI, and about 100 GB free on the system drive. Open PowerShell as administrator (right-click the Start button, then Terminal (Admin)) and run:

```powershell
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/Grid-Decentralized-Compute/grid/main/scripts/host-setup.ps1 -OutFile host-setup.ps1
notepad host-setup.ps1      # read it first
$env:GRID_PUBLIC_URL = "https://node1.example.com"; powershell -NoProfile -ExecutionPolicy Bypass -File .\host-setup.ps1
```

The last line is the whole setup. Add `-CheckOnly` to it to run only the checks and see what would change; that changes nothing and works without administrator rights.

The settings are environment variables set in the same window. The first six are passed to `host-setup.sh` unchanged and are described at the top of that file:

* `GRID_PUBLIC_URL` is the https address of the node's API, served by a Cloudflare tunnel. It is the only one you must set.
* `GRID_NAME`, `GRID_PRICE_PER_HOUR`, `GRID_TUNNEL_NAME`, `GRID_REF` and `PUBLIC_IP` are optional.
* `GRID_PRIVATE_KEY` is optional too: a wallet you already have (`0x` and 64 hex characters), used as the host wallet instead of a new one. `host-setup.sh` does not read it, so the Windows script writes it into `node/.env` afterwards and restarts the node. It is sent to Ubuntu on standard input and never printed. The generated wallet's old file is kept next to it as `.env.before-key-import`.

Any other setting, such as `GRID_HOURS` or the swarm limits, goes into `/opt/grid/node/.env` inside Ubuntu once the script has finished ([Node configuration](../reference/config.md)).

The script does these things, in order, and every step checks before it changes anything:

1. Checks Windows, the NVIDIA driver and virtualization. If something is missing it says what and stops.
2. Installs WSL2 and Ubuntu 24.04 if they are missing. If Windows needs a restart first, the script says so; restart and run the same command again, and it carries on from there.
3. Turns on systemd inside Ubuntu, which `host-setup.sh` needs. It also turns off the mounting of your Windows drives and the launching of Windows programs from inside Ubuntu, because renters' code runs in containers there.
4. On Windows 11 22H2 or newer, sets mirrored networking in `.wslconfig`, so that ports 2222 (renters' SSH) and 4001 (peer to peer) reach Ubuntu directly, and adds a Hyper-V firewall rule that lets them in. On older Windows it says so and falls back to `netsh interface portproxy` rules and a Windows Firewall rule, which the startup task refreshes at every logon because Ubuntu's internal address changes.
5. Creates a `gridadmin` user in Ubuntu with no password, lets it use `sudo` without one only while the script runs, and runs `host-setup.sh` as that user. Docker Engine, the NVIDIA Container Toolkit, Node.js, cloudflared and the node service are installed there. For administration afterwards use `wsl -d Ubuntu-24.04 -u root`.
6. If the Cloudflare tunnel does not exist yet, offers to log in to Cloudflare. You open a link in your browser, approve, and the script creates the tunnel.
7. Registers a scheduled task, "Grid node (WSL)", that starts Ubuntu at every logon and keeps it running. The node is a systemd service, so it starts with Ubuntu.

## After the script

The script ends with a list of what is still needed. These are on it:

* Send test ETH to the host wallet it prints. It pays for listing the machine.
* On your router, forward TCP 2222 and 4001 to this PC, and give the PC a fixed address in the router. Do not forward 7777: the node's API stays on the machine and is reached only through the tunnel.
* If `host-setup.sh` says it installed the node but did not start it, the contracts for this chain are not in the checkout yet. Run the script again once they are.

To check that the node is up:

```powershell
wsl -d Ubuntu-24.04 -- systemctl status grid-node --no-pager
wsl -d Ubuntu-24.04 -u root -- journalctl -u grid-node -f
curl.exe https://node1.example.com/health
```

To update the node, run the same command again.

## What to know about hosting from a gaming PC

* The machine must stay on and signed in. Ubuntu runs only while you are signed in to Windows, so signing out stops the node; locking the screen does not. Turn off sleep, and sign in again after a Windows Update restart. When Ubuntu stops, the node goes offline and the containers of any running rental stop with it.
* Gaming while hosting shares the GPU with the renter, and both slow down. Stop the task (`Stop-ScheduledTask -TaskName "Grid node (WSL)"`, then `wsl --terminate Ubuntu-24.04`) before you play, or set `GRID_HOURS` so the machine is on offer only when you are not at it.
* WSL2 passes the GPU through for CUDA only. Renters get compute, not a display or a graphics API.
* Compute speed is close to native. Disk access crosses a virtual disk and is slower. WSL2 takes up to half of the PC's memory by default; change that with `memory=` in `.wslconfig`.
* WSL2 is a virtual machine on your everyday PC, not a dedicated host. The script closes the doors it can (no Windows drives or programs inside Ubuntu, a firewall that keeps renters' containers off your network), but a container escape is a risk you take on with strangers' code. A separate machine is safer than one that holds your files and logins.

## Removing the Windows setup

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\host-setup.ps1 -Uninstall
```

This removes the scheduled task and the port and firewall rules. It leaves Ubuntu and the node in place, and `.wslconfig` as it is. To stop the node, run `wsl --terminate Ubuntu-24.04`. To remove Ubuntu for good, run `wsl --unregister Ubuntu-24.04`; that deletes the host wallet's key in `/opt/grid/node/.env`, so collect your earnings from the **Host** page and save the key first (`wsl --export Ubuntu-24.04 grid-backup.tar` keeps a copy of everything).

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

* **Direct rental:** starts a container from `GRID_DOCKER_IMAGE` with the host's GPUs (every card, or its one card when `GRID_GPU` is set), hands the renter an SSH login, and settles on-chain when the paid time is up. Stopping the node leaves a running rental's container up; the node adopts it again when it returns.
* **Swarm:** while the machine is not rented, claims small batches of tasks, runs each in a throwaway container with no network, keeps the output and submits its hash. It downloads a job's image before it claims the job's tasks, so a task always starts the moment it is claimed.
* **Network:** keeps libp2p connections to other nodes and announces itself every 15 seconds.

## What a host publishes

A listing is public and permanent, so the node puts nothing personal in it:

* the name you chose with `GRID_NAME` (never the computer's hostname), the GPU model and memory, the CPU model, the RAM and disk sizes, and the operating system family;
* the https address of the node's API;
* its peer-to-peer address when it takes direct rentals, which is the machine's public IP unless you announce a DNS name. A swarm-only host (`GRID_DIRECT=0`, or no `GRID_PUBLIC_URL`) publishes no IP address: its API is reached through the tunnel or a relay.

The address and port for SSH go only to the renter of the machine, in reply to a request signed by their wallet. The host wallet's address is public, as on any chain, and the peers and the RPC endpoint a node connects to see the address it connects from, as with any program on the internet.

Swarm jobs are public as well: a job's image, command and task inputs are posted on-chain, and its outputs are served to anyone who asks for them. Keep private data out of jobs.

## Bond and earnings

For the first 30 days a host needs no bond, but each direct rental is capped at 0.01 ETH. After that, and for swarm work whenever bonding is on, the host keeps GRID bonded in `StakeRegistry`. A bond cannot be withdrawn while one of the host's rentals is running, and takes seven days to come back. Earnings from both markets accrue in the contracts and are collected from the **Host** page.
