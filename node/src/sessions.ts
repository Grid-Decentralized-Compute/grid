import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { AccessInfo } from "@grid/shared";
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

/**
 * One SSH container per rental. In simulated mode nothing is started and the
 * access details are fake, which is enough to try the whole market flow.
 */
export class SessionManager {
  private readonly sessions = new Map<bigint, Session>();
  private docker = false;

  constructor(private readonly config: Config) {}

  async init() {
    if (this.config.simulate === true) {
      log("mode: simulated (GRID_SIMULATE=1) — no containers will be started");
      return;
    }
    try {
      const { stdout } = await run("docker", ["version", "--format", "{{.Server.Version}}"]);
      this.docker = true;
      log(`mode: docker ${stdout.trim()}`);
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

  /** Proves Docker can hand the GPU to a container before a renter depends on it. */
  async preflightGpu() {
    if (!this.docker) return;
    try {
      await run("docker", ["run", "--rm", "--gpus", "all", "--entrypoint", "true", this.config.dockerImage]);
      log("docker can pass the GPU through");
    } catch (e) {
      throw new Error(
        `nvidia-smi found a GPU but Docker cannot pass it through (${(e as Error).message.split("\n")[0]}). ` +
          "Install the NVIDIA Container Toolkit, or set GRID_SIMULATE=1.",
      );
    }
  }

  /** Removes rental containers left behind by an earlier run, except the one for `keep` (still rented). */
  async sweep(keep: bigint | null) {
    if (!this.docker) return;
    const { stdout } = await run("docker", ["ps", "-a", "--filter", "name=^grid-rental-", "--format", "{{.ID}} {{.Names}}"]);
    for (const line of stdout.split("\n")) {
      const [id, name] = line.trim().split(/\s+/);
      if (!id) continue;
      if (keep !== null && name === containerName(keep)) continue;
      await run("docker", ["rm", "-f", id]).catch(() => {});
      log(`removed stale container ${name}`);
    }
  }

  async start(rentalId: bigint, renter: `0x${string}`, endsAt: number, gpu: boolean): Promise<Session> {
    const existing = this.sessions.get(rentalId);
    if (existing) return existing;

    const host = this.config.sshHost;
    const port = this.config.sshPort;
    const user = "grid";
    let password = randomBytes(12).toString("base64url");
    let containerId: string | null = null;

    if (this.docker) {
      const name = containerName(rentalId);
      // A node restart in the middle of a rental must not wipe the renter's work:
      // reuse the running container and its password instead of recreating it.
      const running = await this.inspect(name);
      if (running) {
        containerId = running.id;
        password = running.password;
        log(`adopted running container ${name}`);
      } else {
        await run("docker", ["rm", "-f", name]).catch(() => {});
        const args = [
          "run", "-d", "--name", name,
          "-p", `${port}:2222`,
          "-e", "PUID=1000", "-e", "PGID=1000",
          "-e", `USER_NAME=${user}`, "-e", `USER_PASSWORD=${password}`,
          "-e", "PASSWORD_ACCESS=true", "-e", "SUDO_ACCESS=true",
        ];
        if (gpu) args.push("--gpus", "all");
        args.push(this.config.dockerImage);
        const { stdout } = await run("docker", args);
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
        password,
        command: `ssh -p ${port} ${user}@${host}`,
        endsAt,
      },
    };
    this.sessions.set(rentalId, session);
    return session;
  }

  /** Tears the rental's container down. */
  async stop(rentalId: bigint) {
    const session = this.sessions.get(rentalId);
    if (!session) return;
    this.sessions.delete(rentalId);
    if (session.containerId) {
      await run("docker", ["rm", "-f", session.containerId]).catch((e: Error) => log(`docker rm failed: ${e.message}`));
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

  private async inspect(name: string): Promise<{ id: string; password: string } | null> {
    try {
      const { stdout } = await run("docker", [
        "inspect", "--format", "{{.State.Running}} {{.Id}}{{range .Config.Env}}\n{{.}}{{end}}", name,
      ]);
      const [first, ...env] = stdout.split("\n");
      const [running, id] = first.trim().split(" ");
      const password = env.map((l) => l.trim()).find((l) => l.startsWith("USER_PASSWORD="))?.slice("USER_PASSWORD=".length);
      return running === "true" && id && password ? { id, password } : null;
    } catch {
      return null;
    }
  }
}
