#!/usr/bin/env bash
# One-shot setup for a Grid GPU host on Ubuntu 22.04 or 24.04 with an NVIDIA driver already installed.
# Safe to run again: every step checks before it changes anything.
#
#   GRID_PUBLIC_URL=https://node1.example.com bash host-setup.sh
#
# Read it before running it. To run exactly a reviewed version, set GRID_REF to a tag or commit.
#
# Settings (environment variables):
#   GRID_PUBLIC_URL      https address of this node's API, served by a Cloudflare tunnel  (required)
#   GRID_NAME            how the machine shows up in the market      (default host-1; letters, digits, . _ - and spaces)
#   GRID_PRICE_PER_HOUR  ETH per hour for a direct rental            (default 0.0005)
#   GRID_TUNNEL_NAME     Cloudflare tunnel name                      (default grid-node1)
#   GRID_REF             git tag or commit to run                    (default main)
#   PUBLIC_IP            this network's public IPv4 address          (default: detected)
#
# What it does: checks the GPU, driver and NVIDIA Container Toolkit; installs Docker, the toolkit,
# Node.js and cloudflared from their signed package repositories; creates a "grid" system user
# that runs the node (never your own account) with the code in /opt/grid; builds the rental image
# and proves the GPU works inside it; creates the "grid-rental" docker network and firewall rules
# that keep renters' containers off this machine's LAN and services; writes node/.env with a new
# host wallet; installs hardened systemd services for the node and the tunnel.
set -euo pipefail

REPO_URL="https://github.com/Grid-Decentralized-Compute/grid"
GRID_DIR="/opt/grid"
GRID_USER="grid"
GRID_REF="${GRID_REF:-main}"
GRID_NAME="${GRID_NAME:-host-1}"
GRID_PRICE_PER_HOUR="${GRID_PRICE_PER_HOUR:-0.0005}"
GRID_PUBLIC_URL="${GRID_PUBLIC_URL:-}"
GRID_TUNNEL_NAME="${GRID_TUNNEL_NAME:-grid-node1}"
CUDA_TEST_IMAGE="nvidia/cuda:12.8.1-base-ubuntu24.04"
MIN_TOOLKIT="1.17.8"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
fail() { printf '\n\033[31mstopped: %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
as_grid() { sudo -u "$GRID_USER" -H "$@"; }

step "Checking this machine and the settings"
[ "$(id -u)" -ne 0 ] || fail "run this as a normal user with sudo rights, not as root"
[[ "$GRID_PUBLIC_URL" =~ ^https://[A-Za-z0-9.-]+$ ]] || fail "set GRID_PUBLIC_URL to the https address this node will have, e.g. https://node1.example.com"
[[ "$GRID_NAME" =~ ^[A-Za-z0-9\ ._-]{1,48}$ ]] || fail "GRID_NAME may use letters, digits, spaces, dots, dashes and underscores (48 at most)"
[[ "$GRID_PRICE_PER_HOUR" =~ ^[0-9]+(\.[0-9]+)?$ ]] || fail "GRID_PRICE_PER_HOUR must be a number of ETH, e.g. 0.0005"
[[ "$GRID_REF" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "GRID_REF must be a tag, branch or commit"
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || note "this script is written for Ubuntu; ${PRETTY_NAME:-this system} may need changes"
have nvidia-smi || fail "no NVIDIA driver. Install one (sudo ubuntu-drivers install), reboot, then run this again"
driver="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1 | tr -d ' ')"
[ "${driver%%.*}" -ge 570 ] || fail "driver $driver is too old; RTX 50-series cards and CUDA 12.8 need 570 or newer"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | sed 's/^/   GPU: /'
note "driver $driver"
free_gb="$(df -BG --output=avail / | tail -1 | tr -dc '0-9')"
[ "$free_gb" -ge 60 ] || note "only ${free_gb} GB free; container images and renters' work need room (100 GB+ is comfortable)"

step "Base packages and automatic security updates"
sudo apt-get update -qq
sudo apt-get install -y -qq ca-certificates curl gnupg git iptables unattended-upgrades >/dev/null
sudo dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

step "Docker"
if ! have docker; then
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin >/dev/null
fi
sudo systemctl enable --now docker >/dev/null
note "$(sudo docker version --format 'Docker {{.Server.Version}}')"

step "NVIDIA Container Toolkit"
if ! have nvidia-ctk; then
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
    | sudo gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
  sudo apt-get update -qq
fi
sudo apt-get install -y -qq --only-upgrade nvidia-container-toolkit >/dev/null 2>&1 || sudo apt-get install -y -qq nvidia-container-toolkit >/dev/null
toolkit="$(dpkg-query -W -f='${Version}' nvidia-container-toolkit)"
# Older toolkits have public container-escape bugs that a stranger's image alone can trigger.
dpkg --compare-versions "$toolkit" ge "$MIN_TOOLKIT" || fail "NVIDIA Container Toolkit $toolkit is too old; $MIN_TOOLKIT or newer is required"
sudo nvidia-ctk runtime configure --runtime=docker >/dev/null
sudo systemctl restart docker
note "toolkit $toolkit"
sudo docker run --rm --gpus all "$CUDA_TEST_IMAGE" nvidia-smi -L | sed 's/^/   inside a container: /' \
  || fail "Docker cannot pass the GPU through; check the driver and the toolkit"

step "Node.js"
node_ok() { have node && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>24||(a===24&&b>=13)||(a===22&&b>=22)?0:1)'; }
if ! node_ok; then
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    | sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq nodejs >/dev/null
fi
node_ok || fail "Node.js $(node -v 2>/dev/null) is too old; Grid needs 22.22+ or 24.13+"
note "Node.js $(node -v)"

step "cloudflared"
if ! have cloudflared; then
  sudo mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
    | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq cloudflared >/dev/null
fi
note "$(cloudflared --version 2>&1 | head -1)"

step "The grid user"
# The node runs as its own system user, never as the admin who runs this script. That user is in
# the docker group, which docker makes root-equivalent, so nothing else should run as it.
if ! id "$GRID_USER" >/dev/null 2>&1; then
  sudo useradd --system --home-dir "$GRID_DIR" --shell /usr/sbin/nologin "$GRID_USER"
fi
sudo usermod -aG docker "$GRID_USER"
sudo install -d -o "$GRID_USER" -g "$GRID_USER" -m 0750 "$GRID_DIR"
note "user $GRID_USER, home $GRID_DIR"

step "Grid code ($GRID_REF)"
if [ -d "$GRID_DIR/.git" ]; then
  as_grid git -C "$GRID_DIR" fetch --quiet --tags origin
else
  as_grid git clone --quiet "$REPO_URL" "$GRID_DIR/src.tmp"
  sudo -u "$GRID_USER" bash -c "shopt -s dotglob; mv '$GRID_DIR/src.tmp/'* '$GRID_DIR/' && rmdir '$GRID_DIR/src.tmp'"
fi
as_grid git -C "$GRID_DIR" checkout --quiet "$GRID_REF"
[ "$GRID_REF" = "main" ] && as_grid git -C "$GRID_DIR" pull --quiet --ff-only origin main
# No dependency install scripts: a compromised package cannot run code at install time.
(cd "$GRID_DIR" && as_grid npm ci --ignore-scripts --no-audit --no-fund --loglevel=error)
note "code at $GRID_DIR ($(git -C "$GRID_DIR" log -1 --format=%h))"

step "Rental image"
sudo docker build -q -t grid-rental "$GRID_DIR/node/rental-image" >/dev/null
sudo docker run --rm --gpus all --entrypoint nvidia-smi grid-rental -L | sed 's/^/   renters will see: /' \
  || fail "the GPU does not work inside the rental image"

step "Renter network and firewall"
# Renters' containers get their own bridge with no container-to-container traffic, and rules that
# drop anything they send to private networks (the LAN, the router, cloud metadata) or to this
# machine itself. Inbound SSH to their container still works through docker's port mapping.
sudo docker network inspect grid-rental >/dev/null 2>&1 || sudo docker network create \
  --opt com.docker.network.bridge.name=grid0 \
  --opt com.docker.network.bridge.enable_icc=false \
  grid-rental >/dev/null
sudo tee /usr/local/sbin/grid-firewall >/dev/null <<'FW'
#!/bin/sh
# Keeps containers on the grid0 bridge (renters) away from private networks and from this host.
set -e
add() { iptables -C "$@" 2>/dev/null || iptables -I "$@"; }
add6() { ip6tables -C "$@" 2>/dev/null || ip6tables -I "$@"; }
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
  add DOCKER-USER -i grid0 -d "$net" -j DROP
done
add DOCKER-USER -i grid0 -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
add INPUT -i grid0 -j DROP
add6 INPUT -i grid0 -j DROP 2>/dev/null || true
for net in fc00::/7 fe80::/10; do add6 FORWARD -i grid0 -d "$net" -j DROP 2>/dev/null || true; done
FW
sudo chmod 755 /usr/local/sbin/grid-firewall
sudo tee /etc/systemd/system/grid-firewall.service >/dev/null <<'UNIT'
[Unit]
Description=Grid: keep renters' containers off the LAN and this host
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/grid-firewall
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now grid-firewall >/dev/null
note "network grid-rental (bridge grid0) with LAN and host access blocked"

step "Node settings"
ENV_FILE="$GRID_DIR/node/.env"
PUBLIC_IP="${PUBLIC_IP:-$(curl -4 -fsS https://www.cloudflare.com/cdn-cgi/trace | sed -n 's/^ip=//p')}"
[[ "$PUBLIC_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || fail "could not detect the public IPv4 address; set PUBLIC_IP and run again"
if sudo test -f "$ENV_FILE"; then
  note "keeping the existing $ENV_FILE"
else
  key="${GRID_PRIVATE_KEY:-$(cd "$GRID_DIR" && as_grid node --input-type=module -e 'import { generatePrivateKey } from "viem/accounts"; console.log(generatePrivateKey())')}"
  sudo -u "$GRID_USER" bash -c "umask 077; cat > '$ENV_FILE'" <<EOF
# Written by scripts/host-setup.sh. Robinhood Chain testnet. Keep this file private: it holds the
# host wallet's key, and the ETH this machine earns is paid to that wallet. Back it up somewhere safe.
GRID_CHAIN_ID=46630
GRID_RPC_URL=https://rpc.testnet.chain.robinhood.com
GRID_PRIVATE_KEY=$key
GRID_NAME="$GRID_NAME"
GRID_PRICE_PER_HOUR=$GRID_PRICE_PER_HOUR

# The API is reached only through the local Cloudflare tunnel, so it listens on loopback. SSH and
# peer-to-peer traffic come straight to this network's public IP (the tunnel carries neither), on
# ports the router forwards here.
GRID_PUBLIC_URL=$GRID_PUBLIC_URL
GRID_PORT=7777
GRID_BIND=127.0.0.1
GRID_SSH_HOST=$PUBLIC_IP
GRID_SSH_PORT=2222
GRID_DOCKER_IMAGE=grid-rental
GRID_P2P_PORT=4001
GRID_P2P_ANNOUNCE=/ip4/$PUBLIC_IP/tcp/4001
GRID_RELAY=1
EOF
  note "wrote $ENV_FILE with a new host wallet"
fi
# Read the key without executing the file as shell.
HOST_KEY="$(sudo grep -m1 '^GRID_PRIVATE_KEY=' "$ENV_FILE" | cut -d= -f2)"
HOST_ADDRESS="$(cd "$GRID_DIR" && GRID_KEY="$HOST_KEY" as_grid --preserve-env=GRID_KEY node --input-type=module -e 'import { privateKeyToAccount } from "viem/accounts"; console.log(privateKeyToAccount(process.env.GRID_KEY).address)')"
unset HOST_KEY
note "host wallet $HOST_ADDRESS"
note "public IP $PUBLIC_IP (renters SSH to port 2222 here)"

step "Host firewall"
if have ufw && sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow 2222/tcp >/dev/null && sudo ufw allow 4001/tcp >/dev/null
  note "ufw: opened 2222/tcp and 4001/tcp (the API stays on loopback)"
else
  note "ufw is off; the router still needs TCP 2222 and 4001 forwarded here"
fi

step "Node service"
sudo tee /etc/systemd/system/grid-node.service >/dev/null <<EOF
[Unit]
Description=Grid node
After=network-online.target docker.service grid-firewall.service
Wants=network-online.target
Requires=docker.service grid-firewall.service

[Service]
User=$GRID_USER
Group=$GRID_USER
SupplementaryGroups=docker
WorkingDirectory=$GRID_DIR
ExecStart=$(command -v npm) run node
Restart=always
RestartSec=15
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$GRID_DIR
RestrictSUIDSGID=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable grid-node >/dev/null
if grep -q '"46630"' "$GRID_DIR/packages/shared/src/generated/deployments.ts" 2>/dev/null; then
  sudo systemctl restart grid-node
  note "grid-node is running: journalctl -u grid-node -f"
else
  note "installed but not started: the testnet contracts are not in this checkout yet."
  note "after they are deployed: run this script again (GRID_REF=main) and it starts the node"
fi

step "Tunnel for $GRID_PUBLIC_URL"
TUNNEL_HOST="${GRID_PUBLIC_URL#https://}"
if [ -f /etc/cloudflared/config.yml ] && sudo grep -q "hostname: $TUNNEL_HOST" /etc/cloudflared/config.yml; then
  note "already set up"
elif [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  note "not set up yet. Run:  cloudflared tunnel login"
  note "open the link it prints, pick the zone for $TUNNEL_HOST, then run this script again."
else
  cloudflared tunnel list 2>/dev/null | grep -qw "$GRID_TUNNEL_NAME" || cloudflared tunnel create "$GRID_TUNNEL_NAME" >/dev/null
  TUNNEL_ID="$(cloudflared tunnel list 2>/dev/null | awk -v n="$GRID_TUNNEL_NAME" '$2 == n { print $1 }')"
  [ -n "$TUNNEL_ID" ] || fail "could not create the tunnel"
  cloudflared tunnel route dns "$GRID_TUNNEL_NAME" "$TUNNEL_HOST" >/dev/null \
    || note "the DNS record for $TUNNEL_HOST exists already or could not be created; check it in Cloudflare"
  sudo mkdir -p /etc/cloudflared
  sudo install -m 600 "$HOME/.cloudflared/$TUNNEL_ID.json" "/etc/cloudflared/$TUNNEL_ID.json"
  sudo tee /etc/cloudflared/config.yml >/dev/null <<EOF
tunnel: $TUNNEL_ID
credentials-file: /etc/cloudflared/$TUNNEL_ID.json
ingress:
  - hostname: $TUNNEL_HOST
    service: http://127.0.0.1:7777
  - service: http_status:404
EOF
  if systemctl list-unit-files | grep -q '^cloudflared.service'; then
    sudo systemctl restart cloudflared
  else
    sudo cloudflared service install >/dev/null
  fi
  # The login certificate can edit every DNS record in the zone; this machine runs strangers'
  # code, so it does not keep it. The tunnel only needs its own credentials file.
  rm -f "$HOME/.cloudflared/cert.pem" "$HOME/.cloudflared/$TUNNEL_ID.json"
  note "tunnel $GRID_TUNNEL_NAME -> $TUNNEL_HOST -> 127.0.0.1:7777 (zone certificate removed)"
fi

step "Done"
note "Still needed: test ETH for $HOST_ADDRESS (it pays for listing the machine),"
note "and the router forwarding TCP 2222 and 4001 to this machine."
note "This host runs strangers' swarm jobs between rentals, in locked-down containers. GRID_SWARM=0 in node/.env turns that off."
note "Check from outside:  curl $GRID_PUBLIC_URL/health"
