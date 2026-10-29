#!/bin/sh
# Creates the renter's account from the variables the node passes, then runs sshd on port 2222.
set -eu

user="${USER_NAME:-grid}"
: "${USER_PASSWORD:?USER_PASSWORD is required}"

if ! id "$user" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --uid "${PUID:-1000}" "$user" 2>/dev/null \
    || useradd --create-home --shell /bin/bash "$user"
fi
echo "$user:$USER_PASSWORD" | chpasswd

if [ "${SUDO_ACCESS:-false}" = "true" ]; then
  echo "$user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/grid-renter
  chmod 440 /etc/sudoers.d/grid-renter
fi

# SSH logins start with a clean environment. Carry over what CUDA programs need (paths and the
# NVIDIA variables) and nothing else: the password must not end up in the renter's shell.
env | grep -E '^(PATH|LD_LIBRARY_PATH|LIBRARY_PATH|CUDA_[A-Z_]*|CUDNN_[A-Z_]*|NV_[A-Z_]*|NVIDIA_[A-Z_]*)=' > /etc/environment || true
printf 'Welcome to a Grid machine. nvidia-smi shows the GPU; python3 and pip are installed.\n' > /etc/motd

mkdir -p /run/sshd
ssh-keygen -A >/dev/null
password_auth=no
[ "${PASSWORD_ACCESS:-false}" = "true" ] && password_auth=yes
cat > /etc/ssh/sshd_config.d/grid.conf <<EOF
Port 2222
PermitRootLogin no
PasswordAuthentication $password_auth
KbdInteractiveAuthentication no
AllowUsers $user
MaxAuthTries 3
LoginGraceTime 20
X11Forwarding no
ClientAliveInterval 60
EOF

exec /usr/sbin/sshd -D -e
