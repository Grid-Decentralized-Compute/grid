#!/usr/bin/env bash
# One-shot setup for a Grid GPU host on Ubuntu 22.04 or 24.04 with an NVIDIA driver already installed.
# Safe to run again: every step checks before it changes anything.
#
#   GRID_PUBLIC_URL=https://node1.example.com bash host-setup.sh
#
# A rig with several GPUs runs one host per card, each with its own wallet, listing and bond, so the
# cards can check each other's swarm work and be rented one by one. Put {n} in the address for that:
#
#   GRID_PUBLIC_URL='https://rig1-{n}.example.com' bash host-setup.sh
#
# gives rig1-1, rig1-2, ... one per GPU, all served by a single tunnel. Keep {n} in the first label
# of the name (rig1-{n}.example.com, not gpu{n}.rig1.example.com): Cloudflare's free certificate
# covers one level of subdomain.
#
# Read it before running it. To run exactly a reviewed version, set GRID_REF to a tag or commit.
#
# Settings (environment variables):
#   GRID_PUBLIC_URL      https address of the node's API, served by a Cloudflare tunnel  (required)
#   GRID_NAME            how the machine shows up in the market      (default host-1, or host-{n} per GPU;
#                                                                     letters, digits, . _ - and spaces)
#   GRID_PRICE_PER_HOUR  ETH per hour for a direct rental            (default 0.0005)
#   GRID_DIRECT          0 = swarm work only: no SSH rentals, and no router ports needed (default 1)
#   GRID_HOSTS           per GPU: use only the first this-many cards (default: all of them)
#   GRID_KEYS_FILE       file with one host wallet key per line, for wallets prepared in advance
#                        (default: new wallets are made here). It is deleted once the keys are stored.
#   GRID_TUNNEL_NAME     Cloudflare tunnel name                      (default grid-node1)
#   GRID_TUNNEL_CREDENTIALS  credentials file of a tunnel created on another computer, with its DNS
#                        records already in place. With it this machine never sees the Cloudflare login.
#   GRID_REF             git tag or commit to run                    (default main)
#   PUBLIC_IP            this network's public IPv4 address          (default: detected)
#
# What it does: checks the GPU, driver and NVIDIA Container Toolkit; installs Docker, the toolkit,
# Node.js and cloudflared from their signed package repositories; creates a "grid" system user
# that runs the node (never your own account) with the code in /opt/grid; builds the rental image
# and proves the GPU works inside it; creates the "grid-rental" docker network and firewall rules
# that keep renters' containers off this machine's LAN and services; writes the settings of each
# host with its wallet; installs hardened systemd services for the nodes and the tunnel.
#
# Ports, for host n (n = 1 on a single-host machine): API 7776+n on loopback (reached through the
# tunnel), renters' SSH 2221+n and peer-to-peer 4000+n on the public IP. Only those last two need
# forwarding on the router, and with GRID_DIRECT=0 nothing does.
set -euo pipefail

REPO_URL="https://github.com/Grid-Decentralized-Compute/grid"
GRID_DIR="/opt/grid"
GRID_USER="grid"
GRID_REF="${GRID_REF:-main}"
GRID_PRICE_PER_HOUR="${GRID_PRICE_PER_HOUR:-0.0005}"
GRID_PUBLIC_URL="${GRID_PUBLIC_URL:-}"
GRID_TUNNEL_NAME="${GRID_TUNNEL_NAME:-grid-node1}"
GRID_TUNNEL_CREDENTIALS="${GRID_TUNNEL_CREDENTIALS:-}"
GRID_DIRECT="${GRID_DIRECT:-1}"
GRID_HOSTS="${GRID_HOSTS:-}"
GRID_KEYS_FILE="${GRID_KEYS_FILE:-}"
# {n} in the address means one host per GPU.
PER_GPU=0
if [[ "$GRID_PUBLIC_URL" == *"{n}"* ]]; then PER_GPU=1; fi
if [ "$PER_GPU" = 1 ]; then GRID_NAME="${GRID_NAME:-host-{n\}}"; else GRID_NAME="${GRID_NAME:-host-1}"; fi
# A name without {n} gets the number added, so six hosts never share one name.
if [ "$PER_GPU" = 1 ] && [[ "$GRID_NAME" != *"{n}"* ]]; then GRID_NAME="$GRID_NAME {n}"; fi
CUDA_TEST_IMAGE="nvidia/cuda:12.8.1-base-ubuntu24.04"
MIN_TOOLKIT="1.17.8"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
fail() { printf '\n\033[31mstopped: %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
as_grid() { sudo -u "$GRID_USER" -H "$@"; }
# The address, name and settings file of host n.
host_url() { printf '%s' "${GRID_PUBLIC_URL//\{n\}/$1}"; }
host_name() { printf '%s' "${GRID_NAME//\{n\}/$1}"; }
host_env() { if [ "$PER_GPU" = 1 ]; then printf '%s' "$GRID_DIR/node/hosts/$1.env"; else printf '%s' "$GRID_DIR/node/.env"; fi; }

step "Checking this machine and the settings"
[ "$(id -u)" -ne 0 ] || fail "run this as a normal user with sudo rights, not as root"
[[ "$(host_url 1)" =~ ^https://[A-Za-z0-9.-]+$ ]] || fail "set GRID_PUBLIC_URL to the https address this node will have, e.g. https://node1.example.com (or https://rig1-{n}.example.com for one host per GPU)"
[[ "$(host_name 1)" =~ ^[A-Za-z0-9\ ._-]{1,48}$ ]] || fail "GRID_NAME may use letters, digits, spaces, dots, dashes and underscores (48 at most)"
[[ "$GRID_DIRECT" =~ ^[01]$ ]] || fail "GRID_DIRECT is 1 (SSH rentals and swarm work) or 0 (swarm work only)"
[[ -z "$GRID_HOSTS" || "$GRID_HOSTS" =~ ^[1-9][0-9]?$ ]] || fail "GRID_HOSTS is a number of hosts, e.g. 4"
[ -z "$GRID_KEYS_FILE" ] || [ -r "$GRID_KEYS_FILE" ] || fail "GRID_KEYS_FILE=$GRID_KEYS_FILE cannot be read"
[ -z "$GRID_TUNNEL_CREDENTIALS" ] || [ -r "$GRID_TUNNEL_CREDENTIALS" ] || fail "GRID_TUNNEL_CREDENTIALS=$GRID_TUNNEL_CREDENTIALS cannot be read"
[[ "$GRID_PRICE_PER_HOUR" =~ ^[0-9]+(\.[0-9]+)?$ ]] || fail "GRID_PRICE_PER_HOUR must be a number of ETH, e.g. 0.0005"
[[ "$GRID_REF" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "GRID_REF must be a tag, branch or commit"
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || note "this script is written for Ubuntu; ${PRETTY_NAME:-this system} may need changes"
have nvidia-smi || fail "no NVIDIA driver. Install one (sudo ubuntu-drivers install), reboot, then run this again"
driver="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1 | tr -d ' ')"
[ "${driver%%.*}" -ge 570 ] || fail "driver $driver is too old; RTX 50-series cards and CUDA 12.8 need 570 or newer"
nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader | sed 's/^/   GPU /'
note "driver $driver"
# One host per card is tied to the card's UUID, which stays the same when another card is moved or removed.
mapfile -t GPU_UUIDS < <(nvidia-smi --query-gpu=uuid --format=csv,noheader | tr -d ' \r')
HOSTS=1
if [ "$PER_GPU" = 1 ]; then
  HOSTS="${#GPU_UUIDS[@]}"
  if [ -n "$GRID_HOSTS" ]; then
    [ "$GRID_HOSTS" -le "$HOSTS" ] || fail "GRID_HOSTS=$GRID_HOSTS but this machine has $HOSTS GPU(s)"
    HOSTS="$GRID_HOSTS"
  fi
  note "one host per GPU: $HOSTS host(s), $(host_url 1) to $(host_url "$HOSTS")"
  ram_gb="$(awk '/MemTotal/ { printf "%d", $2 / 1048576 }' /proc/meminfo)"
  cores="$(nproc)"
  note "each host gets about $((ram_gb * 8 / 10 / HOSTS)) GB of RAM and $(( (cores - 1) / HOSTS > 0 ? (cores - 1) / HOSTS : 1 )) CPU core(s) for its containers ($ram_gb GB, $cores cores in all)"
  [ $((ram_gb / HOSTS)) -ge 8 ] || note "that is little memory per GPU: jobs that load large models need more RAM than this"
  [ "$cores" -gt "$HOSTS" ] || note "fewer CPU cores than hosts: the hosts will share cores while tasks start up"
fi
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
PUBLIC_IP="${PUBLIC_IP:-$(curl -4 -fsS https://www.cloudflare.com/cdn-cgi/trace | sed -n 's/^ip=//p' || true)}"
if [ "$GRID_DIRECT" = 1 ]; then
  [[ "$PUBLIC_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || fail "could not detect the public IPv4 address; set PUBLIC_IP and run again"
fi
# Wallets prepared in advance: one key per line, host n takes line n.
KEYS=()
if [ -n "$GRID_KEYS_FILE" ]; then
  mapfile -t KEYS < <(tr -d ' \t\r' < "$GRID_KEYS_FILE" | grep -v '^$' || true)
  [ "${#KEYS[@]}" -ge "$HOSTS" ] || fail "GRID_KEYS_FILE holds ${#KEYS[@]} key(s) but $HOSTS host(s) need one each"
  for k in "${KEYS[@]:0:$HOSTS}"; do
    [[ "$k" =~ ^0x[0-9a-fA-F]{64}$ ]] || fail "GRID_KEYS_FILE: every line must be a private key, 0x and 64 hex characters"
  done
fi
if [ "$PER_GPU" = 1 ]; then
  # A single-host node/.env would be read by every per-GPU host as well, and it holds a wallet.
  sudo test ! -f "$GRID_DIR/node/.env" || fail "this machine is already set up as one host. Move $GRID_DIR/node/.env away (it holds that host's wallet) and stop grid-node before splitting it into one host per GPU"
  sudo install -d -o "$GRID_USER" -g "$GRID_USER" -m 0700 "$GRID_DIR/node/hosts"
fi

HOST_ADDRESSES=()
for n in $(seq 1 "$HOSTS"); do
  ENV_FILE="$(host_env "$n")"
  if sudo test -f "$ENV_FILE"; then
    note "host $n: keeping the existing $ENV_FILE"
  else
    key="${KEYS[$((n - 1))]:-}"
    if [ -z "$key" ] && [ "$PER_GPU" = 0 ]; then key="${GRID_PRIVATE_KEY:-}"; fi
    if [ -z "$key" ]; then
      key="$(cd "$GRID_DIR" && as_grid node --input-type=module -e 'import { generatePrivateKey } from "viem/accounts"; console.log(generatePrivateKey())')"
    fi
    {
      cat <<EOF
# Written by scripts/host-setup.sh. Robinhood Chain testnet. Keep this file private: it holds the
# host wallet's key, and the ETH this host earns is paid to that wallet. Back it up somewhere safe.
GRID_CHAIN_ID=46630
GRID_RPC_URL=https://rpc.testnet.chain.robinhood.com
GRID_PRIVATE_KEY=$key
GRID_NAME="$(host_name "$n")"
GRID_PRICE_PER_HOUR=$GRID_PRICE_PER_HOUR

# The API is reached only through the local Cloudflare tunnel, so it listens on loopback.
GRID_PUBLIC_URL=$(host_url "$n")
GRID_PORT=$((7776 + n))
GRID_BIND=127.0.0.1
GRID_DOCKER_IMAGE=grid-rental
GRID_P2P_PORT=$((4000 + n))
EOF
      if [ "$PER_GPU" = 1 ]; then
        cat <<EOF

# One of $HOSTS hosts on this machine: this one owns a single GPU, takes its part of the memory and
# CPU, and keeps its own state.
GRID_GPU=${GPU_UUIDS[$((n - 1))]}
GRID_SHARE=$HOSTS
GRID_STATE_DIR=$GRID_DIR/node/.grid-$n
EOF
      fi
      if [ "$GRID_DIRECT" = 1 ]; then
        cat <<EOF

# SSH and peer-to-peer traffic come straight to this network's public IP (the tunnel carries
# neither), on ports the router forwards here.
GRID_SSH_HOST=$PUBLIC_IP
GRID_SSH_PORT=$((2221 + n))
GRID_P2P_ANNOUNCE=/ip4/$PUBLIC_IP/tcp/$((4000 + n))
EOF
        # One relay per machine is enough.
        if [ "$n" = 1 ]; then echo "GRID_RELAY=1"; fi
      else
        cat <<EOF

# Swarm work only: no SSH rentals, so nothing needs forwarding on the router.
GRID_DIRECT=0
GRID_P2P_ANNOUNCE=none
EOF
      fi
    } | sudo -u "$GRID_USER" bash -c "umask 077; cat > '$ENV_FILE'"
    unset key
    note "host $n: wrote $ENV_FILE"
  fi
  # Read the key without executing the file as shell.
  HOST_KEY="$(sudo grep -m1 '^GRID_PRIVATE_KEY=' "$ENV_FILE" | cut -d= -f2)"
  HOST_ADDRESSES+=("$(cd "$GRID_DIR" && GRID_KEY="$HOST_KEY" as_grid --preserve-env=GRID_KEY node --input-type=module -e 'import { privateKeyToAccount } from "viem/accounts"; console.log(privateKeyToAccount(process.env.GRID_KEY).address)')")
  unset HOST_KEY
  note "host $n: wallet ${HOST_ADDRESSES[$((n - 1))]}, $(host_url "$n")"
done
unset KEYS
if [ -n "$GRID_KEYS_FILE" ]; then
  shred -u "$GRID_KEYS_FILE" 2>/dev/null || rm -f "$GRID_KEYS_FILE"
  note "removed $GRID_KEYS_FILE: the keys now live only in the hosts' settings files"
fi
# "2222" for one host, "2222-2227" for six.
ports() { if [ "$HOSTS" -gt 1 ]; then printf '%s-%s' "$(($1 + 1))" "$(($1 + HOSTS))"; else printf '%s' "$(($1 + 1))"; fi; }
if [ "$GRID_DIRECT" = 1 ]; then
  note "public IP $PUBLIC_IP (renters SSH to port $(ports 2221) here)"
fi

step "Host firewall"
if [ "$GRID_DIRECT" != 1 ]; then
  note "swarm only: no inbound ports are opened"
elif have ufw && sudo ufw status | grep -q "Status: active"; then
  for n in $(seq 1 "$HOSTS"); do
    sudo ufw allow "$((2221 + n))/tcp" >/dev/null && sudo ufw allow "$((4000 + n))/tcp" >/dev/null
  done
  note "ufw: opened TCP $(ports 2221) and $(ports 4000) (the API stays on loopback)"
else
  note "ufw is off; the router still needs TCP $(ports 2221) and $(ports 4000) forwarded here"
fi

step "Node service"
# One unit for a single host; a template unit, one instance per GPU, for a rig.
write_unit() { # $1 = unit file, $2 = description, $3 = extra [Service] line
  sudo tee "$1" >/dev/null <<EOF
[Unit]
Description=$2
After=network-online.target docker.service grid-firewall.service
Wants=network-online.target
Requires=docker.service grid-firewall.service

[Service]
User=$GRID_USER
Group=$GRID_USER
SupplementaryGroups=docker
WorkingDirectory=$GRID_DIR
$3
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
}
UNITS=()
if [ "$PER_GPU" = 1 ]; then
  write_unit /etc/systemd/system/grid-node@.service "Grid node, host %i" "EnvironmentFile=$GRID_DIR/node/hosts/%i.env"
  for n in $(seq 1 "$HOSTS"); do UNITS+=("grid-node@$n"); done
else
  write_unit /etc/systemd/system/grid-node.service "Grid node" "# settings: $GRID_DIR/node/.env"
  UNITS+=("grid-node")
fi
sudo systemctl daemon-reload
sudo systemctl enable "${UNITS[@]}" >/dev/null 2>&1
if grep -q '"46630"' "$GRID_DIR/packages/shared/src/generated/deployments.ts" 2>/dev/null; then
  sudo systemctl restart "${UNITS[@]}"
  note "running: ${UNITS[*]}"
  note "logs: journalctl -u '${UNITS[0]%%@*}*' -f"
else
  note "installed but not started: the testnet contracts are not in this checkout yet."
  note "after they are deployed: run this script again (GRID_REF=main) and it starts the node"
fi

step "Tunnel"
# One tunnel carries every host: each address goes to that host's API port on loopback.
ingress() {
  for n in $(seq 1 "$HOSTS"); do
    local url; url="$(host_url "$n")"
    printf '  - hostname: %s\n    service: http://127.0.0.1:%s\n' "${url#https://}" "$((7776 + n))"
  done
  printf '  - service: http_status:404\n'
}
all_routed() {
  sudo test -f /etc/cloudflared/config.yml || return 1
  for n in $(seq 1 "$HOSTS"); do
    local url; url="$(host_url "$n")"
    sudo grep -q "hostname: ${url#https://}\$" /etc/cloudflared/config.yml || return 1
  done
}
start_tunnel() { # $1 = tunnel id
  { printf 'tunnel: %s\ncredentials-file: /etc/cloudflared/%s.json\ningress:\n' "$1" "$1"; ingress; } | sudo tee /etc/cloudflared/config.yml >/dev/null
  if systemctl list-unit-files | grep -q '^cloudflared.service'; then
    sudo systemctl restart cloudflared
  else
    sudo cloudflared service install >/dev/null
  fi
}
if all_routed; then
  note "already set up"
elif [ -n "$GRID_TUNNEL_CREDENTIALS" ]; then
  # A tunnel made on another computer: this machine gets the tunnel's own credentials and nothing else.
  TUNNEL_ID="$(sed -n 's/.*"TunnelID" *: *"\([0-9a-fA-F-]\{36\}\)".*/\1/p' "$GRID_TUNNEL_CREDENTIALS" | head -1)"
  [ -n "$TUNNEL_ID" ] || fail "$GRID_TUNNEL_CREDENTIALS is not a tunnel credentials file (no TunnelID in it)"
  sudo mkdir -p /etc/cloudflared
  sudo install -m 600 "$GRID_TUNNEL_CREDENTIALS" "/etc/cloudflared/$TUNNEL_ID.json"
  start_tunnel "$TUNNEL_ID"
  shred -u "$GRID_TUNNEL_CREDENTIALS" 2>/dev/null || rm -f "$GRID_TUNNEL_CREDENTIALS"
  note "tunnel $TUNNEL_ID serves $HOSTS address(es); its DNS records were made where the tunnel was created"
elif [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  note "not set up yet. Either create the tunnel on your own computer and pass GRID_TUNNEL_CREDENTIALS,"
  note "or run here:  cloudflared tunnel login"
  note "open the link it prints, pick the zone for $(host_url 1), then run this script again."
else
  cloudflared tunnel list 2>/dev/null | grep -qw "$GRID_TUNNEL_NAME" || cloudflared tunnel create "$GRID_TUNNEL_NAME" >/dev/null
  TUNNEL_ID="$(cloudflared tunnel list 2>/dev/null | awk -v n="$GRID_TUNNEL_NAME" '$2 == n { print $1 }')"
  [ -n "$TUNNEL_ID" ] || fail "could not create the tunnel"
  for n in $(seq 1 "$HOSTS"); do
    url="$(host_url "$n")"
    cloudflared tunnel route dns "$GRID_TUNNEL_NAME" "${url#https://}" >/dev/null \
      || note "the DNS record for ${url#https://} exists already or could not be created; check it in Cloudflare"
  done
  sudo mkdir -p /etc/cloudflared
  # After a reinstall the tunnel exists but its credentials file is only on the machine that made it.
  [ -f "$HOME/.cloudflared/$TUNNEL_ID.json" ] || fail "tunnel $GRID_TUNNEL_NAME exists but its credentials file is not here; delete the tunnel in Cloudflare or pick another GRID_TUNNEL_NAME"
  sudo install -m 600 "$HOME/.cloudflared/$TUNNEL_ID.json" "/etc/cloudflared/$TUNNEL_ID.json"
  start_tunnel "$TUNNEL_ID"
  # The login certificate can edit every DNS record in the zone; this machine runs strangers'
  # code, so it does not keep it. The tunnel only needs its own credentials file.
  rm -f "$HOME/.cloudflared/cert.pem" "$HOME/.cloudflared/$TUNNEL_ID.json"
  note "tunnel $GRID_TUNNEL_NAME serves $HOSTS address(es) (zone certificate removed)"
fi

step "Done"
note "Still needed: test ETH for each host wallet (it pays for listing the machine and taking tasks):"
for n in $(seq 1 "$HOSTS"); do note "  host $n  ${HOST_ADDRESSES[$((n - 1))]}"; done
if [ "$GRID_DIRECT" = 1 ]; then note "and the router forwarding TCP $(ports 2221) and $(ports 4000) to this machine."; fi
note "These hosts run strangers' swarm jobs between rentals, in locked-down containers. GRID_SWARM=0 in a host's settings turns that off."
note "Check from outside:"
for n in $(seq 1 "$HOSTS"); do note "  curl $(host_url "$n")/health"; done
