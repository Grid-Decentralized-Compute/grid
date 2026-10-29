# The container a direct renter logs into on a GPU host: Ubuntu with the CUDA runtime and cuDNN,
# Python, and SSH on port 2222. The node starts it with --gpus all and the same variables it passes
# to linuxserver/openssh-server (USER_NAME, USER_PASSWORD, PASSWORD_ACCESS, SUDO_ACCESS), so either
# image works with the node. That one is Alpine-based, which cannot run nvidia-smi or CUDA programs;
# use this one on GPU hosts:
#
#   docker build -t grid-rental node/rental-image
#   GRID_DOCKER_IMAGE=grid-rental
#
# CUDA 12.8 is the first release that supports RTX 50-series (Blackwell) cards; it needs driver 570+.
FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openssh-server sudo ca-certificates curl git nano tmux htop \
      python3 python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 # The base image ships an "ubuntu" user on uid 1000; the renter's account replaces it.
 && (userdel -r ubuntu 2>/dev/null || true) \
 && mkdir -p /run/sshd \
 # Host keys are made per container at start, never baked into the image.
 && rm -f /etc/ssh/ssh_host_*

COPY entrypoint.sh /usr/local/bin/grid-entrypoint
RUN chmod 755 /usr/local/bin/grid-entrypoint

EXPOSE 2222
ENTRYPOINT ["/usr/local/bin/grid-entrypoint"]
