#!/bin/sh
# Creates the renter's account and runs sshd on port 2222. Logins are by SSH key: the node adds the
# renter's public key to ~/.ssh/authorized_keys when they ask for access. Password logins stay off
# unless the node sets PASSWORD_ACCESS=true with a USER_PASSWORD.
set -eu

user="${USER_NAME:-grid}"

if ! id "$user" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --uid "${PUID:-1000}" "$user" 2>/dev/null \
    || useradd --create-home --shell /bin/bash "$user"
fi
# sshd refuses even key logins to a locked account, so it always has a password; with no
# USER_PASSWORD it is a random one that nobody knows.
password="${USER_PASSWORD:-$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')}"
echo "$user:$password" | chpasswd
unset password USER_PASSWORD

home="$(getent passwd "$user" | cut -d: -f6)"
install -d -m 700 -o "$user" -g "$user" "$home/.ssh"
touch "$home/.ssh/authorized_keys"
chown "$user:$user" "$home/.ssh/authorized_keys"
chmod 600 "$home/.ssh/authorized_keys"

if [ "${SUDO_ACCESS:-false}" = "true" ]; then
  echo "$user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/grid-renter
  chmod 440 /etc/sudoers.d/grid-renter
fi

# SSH logins start with a clean environment. Carry over what CUDA programs need (paths and the
# NVIDIA variables) and nothing else.
env | grep -E '^(PATH|LD_LIBRARY_PATH|LIBRARY_PATH|CUDA_[A-Z_]*|CUDNN_[A-Z_]*|NV_[A-Z_]*|NVIDIA_[A-Z_]*)=' > /etc/environment || true
printf 'Welcome to a Grid machine. nvidia-smi shows the GPU; python3 and pip are installed.\n' > /etc/motd

mkdir -p /run/sshd
ssh-keygen -A >/dev/null
password_auth=no
[ "${PASSWORD_ACCESS:-false}" = "true" ] && password_auth=yes
cat > /etc/ssh/sshd_config.d/grid.conf <<EOF
Port 2222
PermitRootLogin no
PubkeyAuthentication yes
PasswordAuthentication $password_auth
KbdInteractiveAuthentication no
AllowUsers $user
MaxAuthTries 3
LoginGraceTime 20
X11Forwarding no
ClientAliveInterval 60
EOF

exec /usr/sbin/sshd -D -e
