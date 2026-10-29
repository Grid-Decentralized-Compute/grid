#!/usr/bin/env bash
# One-shot setup for a Grid GPU host on Ubuntu 22.04 or 24.04 with an NVIDIA driver already installed.
# Safe to run again: every step checks before it changes anything.
#
#   curl -fsSL https://raw.githubusercontent.com/Grid-Decentralized-Compute/grid/main/scripts/host-setup.sh | bash
#   # or, from a checkout:  bash scripts/host-setup.sh
#
# Settings (all optional, as environment variables):
#   GRID_DIR             where the code lives                      (default ~/grid)
#   GRID_NAME            how the machine shows up in the market     (default host-1)
#   GRID_PRICE_PER_HOUR  ETH per hour for a direct rental           (default 0.0005)
#   GRID_PUBLIC_URL      https address of this node's API           (default https://node1.gridcompute.net)
#   GRID_TUNNEL_NAME     Cloudflare tunnel name                     (default grid-node1)
#   PUBLIC_IP            this network's public IP                   (default: detected)
#
# What it does: checks the GPU and driver; installs Docker, the NVIDIA Container Toolkit, Node.js
# and cloudflared; builds the rental image and proves the GPU works inside it; writes node/.env
# with a new host wallet; opens ports 2222 and 4001 in ufw if it is on; installs a systemd service
# for the node; and, once `cloudflared tunnel login` has been done, the tunnel that gives the API
# its https address.
set -euo pipefail

REPO_URL="https://github.com/Grid-Decentralized-Compute/grid"
GRID_DIR="${GRID_DIR:-$HOME/grid}"
GRID_NAME="${GRID_NAME:-host-1}"
GRID_PRICE_PER_HOUR="${GRID_PRICE_PER_HOUR:-0.0005}"
GRID_PUBLIC_URL="${GRID_PUBLIC_URL:-https://node1.gridcompute.net}"
GRID_TUNNEL_NAME="${GRID_TUNNEL_NAME:-grid-node1}"
CUDA_TEST_IMAGE="nvidia/cuda:12.8.1-base-ubuntu24.04"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
fail() { printf '\n\033[31mstopped: %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

step "Checking this machine"
[ "$(id -u)" -ne 0 ] || fail "run this as a normal user with sudo rights, not as root"
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || note "this script is written for Ubuntu; ${PRETTY_NAME:-this system} may need changes"
have nvidia-smi || fail "no NVIDIA driver. Install one (sudo ubuntu-drivers install), reboot, then run this again"
driver="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1 | tr -d ' ')"
[ "${driver%%.*}" -ge 570 ] || fail "driver $driver is too old; RTX 50-series cards and CUDA 12.8 need 570 or newer"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | sed 's/^/   GPU: /'
note "driver $driver"
free_gb="$(df -BG --output=avail "$HOME" | tail -1 | tr -dc '0-9')"
[ "$free_gb" -ge 60 ] || note "only ${free_gb} GB free; container images and renters' work need room (100 GB+ is comfortable)"

step "Base packages"
sudo apt-get update -qq
sudo apt-get install -y -qq ca-certificates curl gnupg git >/dev/null

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
id -nG "$USER" | grep -qw docker || sudo usermod -aG docker "$USER"
note "$(sudo docker version --format 'Docker {{.Server.Version}}')"

step "NVIDIA Container Toolkit"
if ! have nvidia-ctk; then
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
    | sudo gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq nvidia-container-toolkit >/dev/null
fi
sudo nvidia-ctk runtime configure --runtime=docker >/dev/null
sudo systemctl restart docker
sudo docker run --rm --gpus all "$CUDA_TEST_IMAGE" nvidia-smi -L | sed 's/^/   inside a container: /' \
  || fail "Docker cannot pass the GPU through; check the driver and the toolkit"

step "Node.js"
node_ok() { have node && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>24||(a===24&&b>=13)||(a===22&&b>=22)?0:1)'; }
if ! node_ok; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
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

step "Grid"
if [ -d "$GRID_DIR/.git" ]; then
  git -C "$GRID_DIR" pull --ff-only --quiet
else
  git clone --quiet "$REPO_URL" "$GRID_DIR"
fi
(cd "$GRID_DIR" && npm ci --no-audit --no-fund --loglevel=error)
note "code at $GRID_DIR ($(git -C "$GRID_DIR" log -1 --format=%h))"

step "Rental image"
sudo docker build -q -t grid-rental "$GRID_DIR/node/rental-image" >/dev/null
sudo docker run --rm --gpus all --entrypoint nvidia-smi grid-rental -L | sed 's/^/   renters will see: /' \
  || fail "the GPU does not work inside the rental image"

step "Node settings"
ENV_FILE="$GRID_DIR/node/.env"
PUBLIC_IP="${PUBLIC_IP:-$(curl -fsS https://www.cloudflare.com/cdn-cgi/trace | sed -n 's/^ip=//p')}"
[ -n "$PUBLIC_IP" ] || fail "could not detect the public IP; set PUBLIC_IP and run again"
if [ -f "$ENV_FILE" ]; then
  note "keeping the existing $ENV_FILE"
else
  key="$(cd "$GRID_DIR" && node --input-type=module -e 'import { generatePrivateKey } from "viem/accounts"; console.log(generatePrivateKey())')"
  umask 077
  cat > "$ENV_FILE" <<EOF
# Written by scripts/host-setup.sh. Robinhood Chain testnet.
GRID_CHAIN_ID=46630
GRID_RPC_URL=https://rpc.testnet.chain.robinhood.com

# The host wallet: lists the machine and receives the ETH. Keep this file private.
GRID_PRIVATE_KEY=$key

GRID_NAME=$GRID_NAME
GRID_PRICE_PER_HOUR=$GRID_PRICE_PER_HOUR

# The API goes through the Cloudflare tunnel; SSH and peer-to-peer traffic come straight to this
# network's public IP (the tunnel carries neither), on ports forwarded by the router.
GRID_PUBLIC_URL=$GRID_PUBLIC_URL
GRID_PORT=7777
GRID_SSH_HOST=$PUBLIC_IP
GRID_SSH_PORT=2222
GRID_DOCKER_IMAGE=grid-rental
GRID_P2P_PORT=4001
GRID_P2P_ANNOUNCE=/ip4/$PUBLIC_IP/tcp/4001
GRID_RELAY=1
EOF
  umask 022
  note "wrote $ENV_FILE with a new host wallet"
fi
HOST_ADDRESS="$(cd "$GRID_DIR" && set -a && . node/.env && set +a && node --input-type=module -e 'import { privateKeyToAccount } from "viem/accounts"; console.log(privateKeyToAccount(process.env.GRID_PRIVATE_KEY).address)')"
note "host wallet $HOST_ADDRESS"
note "public IP $PUBLIC_IP (renters SSH to port 2222 here)"

step "Firewall"
if have ufw && sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow 2222/tcp >/dev/null && sudo ufw allow 4001/tcp >/dev/null
  note "ufw: opened 2222/tcp and 4001/tcp"
else
  note "ufw is off; nothing to open on this machine (the router still needs 2222 and 4001 forwarded here)"
fi

step "Node service"
sudo tee /etc/systemd/system/grid-node.service >/dev/null <<EOF
[Unit]
Description=Grid node
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
User=$USER
WorkingDirectory=$GRID_DIR
ExecStart=$(command -v npm) run node
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable grid-node >/dev/null
if grep -q '"46630"' "$GRID_DIR/packages/shared/src/generated/"* 2>/dev/null || [ -f "$GRID_DIR/contracts/deployments/46630.json" ]; then
  sudo systemctl restart grid-node
  note "grid-node is running: journalctl -u grid-node -f"
else
  note "installed but not started: the testnet contracts are not in this checkout yet."
  note "after they are deployed: git -C $GRID_DIR pull && sudo systemctl restart grid-node"
fi

step "Tunnel for $GRID_PUBLIC_URL"
TUNNEL_HOST="${GRID_PUBLIC_URL#https://}"
TUNNEL_HOST="${TUNNEL_HOST%%/*}"
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  note "not set up yet. Run:  cloudflared tunnel login"
  note "open the link it prints, pick the gridcompute.net zone, then run this script again."
else
  cloudflared tunnel list 2>/dev/null | grep -qw "$GRID_TUNNEL_NAME" || cloudflared tunnel create "$GRID_TUNNEL_NAME" >/dev/null
  TUNNEL_ID="$(cloudflared tunnel list 2>/dev/null | awk -v n="$GRID_TUNNEL_NAME" '$2 == n { print $1 }')"
  cloudflared tunnel route dns --overwrite-dns "$GRID_TUNNEL_NAME" "$TUNNEL_HOST" >/dev/null 2>&1 || true
  sudo mkdir -p /etc/cloudflared
  sudo cp "$HOME/.cloudflared/$TUNNEL_ID.json" "/etc/cloudflared/$TUNNEL_ID.json"
  sudo tee /etc/cloudflared/config.yml >/dev/null <<EOF
tunnel: $TUNNEL_ID
credentials-file: /etc/cloudflared/$TUNNEL_ID.json
ingress:
  - hostname: $TUNNEL_HOST
    service: http://localhost:7777
  - service: http_status:404
EOF
  if systemctl list-unit-files | grep -q '^cloudflared.service'; then
    sudo systemctl restart cloudflared
  else
    sudo cloudflared service install >/dev/null
  fi
  note "tunnel $GRID_TUNNEL_NAME -> $TUNNEL_HOST -> localhost:7777"
fi

step "Done"
note "Still needed: test ETH for $HOST_ADDRESS (it pays for listing the machine),"
note "and the router forwarding TCP 2222 and 4001 to this machine."
note "Check from outside:  curl $GRID_PUBLIC_URL/health"
