import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { type AccessInfo, normalizeSshKey, sshCommand } from "@grid/shared";
import type { Config } from "./config";
import { log } from "./log";

const run = promisify(execFile);

export type Session = {
  rentalId: bigint;
  renter: `0x${string}`;
  endsAt: number;
  containerId: string | null;
  access: AccessInfo;
};

const containerName = (rentalId: bigint) => `grid-rental-${rentalId}`;

/** A docker network with no route to the host's LAN (created by scripts/host-setup.sh). */
export const RENTAL_NETWORK = "grid-rental";

/**
 * What the docker CLI gets in its environment: enough to find the daemon and nothing else, so the
 * host wallet key in GRID_PRIVATE_KEY never reaches a child process.
 */
export function dockerEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "XDG_RUNTIME_DIR", "SystemRoot"];
  return { ...Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]!])), ...extra };
}


/**
 * One SSH container per rental. In simulated mode nothing is started and the
 * access details are fake, which is enough to try the whole market flow.
 */
export class SessionManager {
  private readonly sessions = new Map<bigint, Session>();
  private docker = false;
  private isolatedNetwork = false;

  constructor(private readonly config: Config) {}

  async init() {
    if (this.config.simulate === true) {
      log("mode: simulated (GRID_SIMULATE=1) — no containers will be started");
      return;
    }
    try {
      const { stdout } = await run("docker", ["version", "--format", "{{.Server.Version}}"], { env: dockerEnv() });
      this.docker = true;
      log(`mode: docker ${stdout.trim()}`);
      this.isolatedNetwork = await run("docker", ["network", "inspect", RENTAL_NETWORK], { env: dockerEnv() }).then(
        () => true,
        () => false,
      );
      if (!this.isolatedNetwork) {
        log(`warning: no "${RENTAL_NETWORK}" docker network, so renters' containers can reach this machine's LAN. scripts/host-setup.sh creates it.`);
      }
    } catch {
      if (this.config.simulate === false) throw new Error("Docker not found; install Docker or set GRID_SIMULATE=1");
      log("mode: simulated — docker not found, so rentals get placeholder access details");
    }
  }

  get mode(): "docker" | "simulated" {
    return this.docker ? "docker" : "simulated";
  }

  get busy() {
    return this.sessions.size > 0;
  }

  get(rentalId: bigint) {
    return this.sessions.get(rentalId);
  }

  /**
   * Proves a renter's container can use the GPU before anyone pays for it: runs nvidia-smi inside
   * the rental image itself. That fails both when Docker cannot pass the GPU through (no NVIDIA
   * Container Toolkit) and when the image cannot run NVIDIA programs (an Alpine image, for example).
   */
  async preflightGpu() {
    if (!this.docker) return;
    const image = this.config.dockerImage;
    try {
      const { stdout } = await run("docker", ["run", "--rm", "--gpus", "all", "--entrypoint", "nvidia-smi", image, "-L"], { env: dockerEnv() });
      log(`GPU works inside ${image}: ${stdout.trim().split("\n")[0]}`);
    } catch (e) {
      throw new Error(
        `nvidia-smi found a GPU but it does not work inside ${image} (${(e as Error).message.split("\n")[0]}). ` +
          "Install the NVIDIA Container Toolkit, and use a CUDA image such as node/rental-image " +
          "(docker build -t grid-rental node/rental-image, then GRID_DOCKER_IMAGE=grid-rental), or set GRID_SIMULATE=1.",
      );
    }
  }

  /** Removes rental containers left behind by an earlier run, except the one for `keep` (still rented). */
  async sweep(keep: bigint | null) {
    if (!this.docker) return;
    const { stdout } = await run("docker", ["ps", "-a", "--filter", "name=^grid-rental-", "--format", "{{.ID}} {{.Names}}"], { env: dockerEnv() });
    for (const line of stdout.split("\n")) {
      const [id, name] = line.trim().split(/\s+/);
      if (!id) continue;
      if (keep !== null && name === containerName(keep)) continue;
      await run("docker", ["rm", "-f", id], { env: dockerEnv() }).catch(() => {});
      log(`removed stale container ${name}`);
    }
  }

  async start(rentalId: bigint, renter: `0x${string}`, endsAt: number, gpu: boolean): Promise<Session> {
    const existing = this.sessions.get(rentalId);
    if (existing) return existing;

    const host = this.config.sshHost;
    const port = this.config.sshPort;
    const user = "grid";
    let containerId: string | null = null;

    if (this.docker) {
      const name = containerName(rentalId);
      // A node restart in the middle of a rental must not wipe the renter's work: reuse the
      // running container (and the keys already in it) instead of recreating it.
      const running = await this.inspect(name);
      if (running) {
        containerId = running;
        log(`adopted running container ${name}`);
      } else {
        await run("docker", ["rm", "-f", name], { env: dockerEnv() }).catch(() => {});
        // The renter is root inside the container; these limits keep them from taking the host
        // down with it (memory, processes, CPU, logs), and the isolated network keeps them off
        // the host's LAN. Logins are by SSH key only: there is no password anywhere, and the
        // renter's key is added when they ask for access (authorize).
        const memMb = Math.max(1024, Math.floor((os.totalmem() * 0.8) / 2 ** 20));
        const args = [
          "run", "-d", "--name", name,
          "-p", `${port}:2222`,
          "--pids-limit", "4096",
          "--memory", `${memMb}m`, "--memory-swap", `${memMb}m`,
          "--cpus", String(Math.max(1, os.cpus().length - 1)),
          "--shm-size", `${Math.min(8192, Math.floor(memMb / 2))}m`,
          "--ulimit", "core=0",
          "--cap-drop", "NET_RAW", "--cap-drop", "MKNOD", "--cap-drop", "AUDIT_WRITE", "--cap-drop", "SETFCAP",
          "--log-driver", "local", "--log-opt", "max-size=20m", "--log-opt", "max-file=2",
          ...(this.isolatedNetwork ? ["--network", RENTAL_NETWORK] : []),
          "-e", "PUID=1000", "-e", "PGID=1000",
          "-e", `USER_NAME=${user}`,
          "-e", "PASSWORD_ACCESS=false", "-e", "SUDO_ACCESS=true",
        ];
        if (gpu) args.push("--gpus", "all");
        args.push(this.config.dockerImage);
        const { stdout } = await run("docker", args, { env: dockerEnv() });
        containerId = stdout.trim();
        log(`started container ${name} (${containerId.slice(0, 12)})`);
      }
    }

    const session: Session = {
      rentalId,
      renter,
      endsAt,
      containerId,
      access: {
        rentalId: rentalId.toString(),
        host,
        port,
        user,
        hostKeys: [],
        command: sshCommand({ host, port, user }),
        endsAt,
      },
    };
    this.sessions.set(rentalId, session);
    return session;
  }

  /**
   * Lets a renter's SSH public key into the rental's container and returns the container's SSH
   * host keys, for the renter's client to check it reached the real machine. Keys are added, never
   * duplicated, at most 10 per rental (a renter may log in from several places). Null while the
   * container is still starting. In simulated mode there is no container: nothing to add.
   */
  async authorize(rentalId: bigint, key: string): Promise<string[] | null> {
    const session = this.sessions.get(rentalId);
    if (!session) return null;
    const clean = normalizeSshKey(key);
    if (!clean) throw new Error("not an SSH public key");
    if (!this.docker || !session.containerId) return [];
    // The user's real home comes from /etc/passwd: images may set HOME to /root for everyone.
    const add = [
      "umask 077",
      `h="$(awk -F: -v u="$(id -un)" '$1==u{print $6}' /etc/passwd)"`,
      `[ -n "$h" ] || exit 4`,
      `mkdir -p "$h/.ssh"`,
      `f="$h/.ssh/authorized_keys"`,
      `touch "$f"`,
      `grep -qxF "$GRID_KEY" "$f" && exit 0`,
      `[ "$(wc -l < "$f")" -lt 10 ] || exit 3`,
      `printf '%s\\n' "$GRID_KEY" >> "$f"`,
    ].join("; ");
    try {
      // The key reaches the container through the environment, never through the shell text.
      await run("docker", ["exec", "-u", session.access.user, "-e", "GRID_KEY", session.containerId, "sh", "-c", add], {
        env: dockerEnv({ GRID_KEY: clean }),
      });
      const { stdout } = await run(
        "docker",
        ["exec", session.containerId, "sh", "-c", "cat /etc/ssh/ssh_host_*_key.pub /config/ssh_host_keys/ssh_host_*_key.pub 2>/dev/null; true"],
        { env: dockerEnv() },
      );
      const hostKeys = stdout.split("\n").map(normalizeSshKey).filter((k): k is string => k !== null).slice(0, 4);
      return hostKeys.length > 0 ? hostKeys : null;
    } catch (e) {
      if ((e as { code?: number }).code === 3) throw new Error("this rental already has 10 SSH keys");
      return null; // the container (or its user) is not up yet
    }
  }

  /** Tears the rental's container down. */
  async stop(rentalId: bigint) {
    const session = this.sessions.get(rentalId);
    if (!session) return;
    this.sessions.delete(rentalId);
    if (session.containerId) {
      await run("docker", ["rm", "-f", session.containerId], { env: dockerEnv() }).catch((e: Error) => log(`docker rm failed: ${e.message}`));
      log(`stopped container for rental #${rentalId}`);
    }
  }

  /** Forgets the session but leaves its container running (the node is going away, the renter is not). */
  release(rentalId: bigint) {
    this.sessions.delete(rentalId);
  }

  async stopAll() {
    for (const id of [...this.sessions.keys()]) await this.stop(id);
  }

  /** The id of the container by that name when it is running, else null. */
  private async inspect(name: string): Promise<string | null> {
    try {
      const { stdout } = await run("docker", ["inspect", "--format", "{{.State.Running}} {{.Id}}", name], { env: dockerEnv() });
      const [running, id] = stdout.trim().split(" ");
      return running === "true" && id ? id : null;
    } catch {
      return null;
    }
  }
}
