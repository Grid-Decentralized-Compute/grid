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

  async start(rentalId: bigint, renter: `0x${string}`, endsAt: number, gpu: boolean): Promise<Session> {
    const existing = this.sessions.get(rentalId);
    if (existing) return existing;

    const password = randomBytes(12).toString("base64url");
    const host = new URL(this.config.publicUrl).hostname;
    const port = this.config.sshPort;
    const user = "grid";

    let containerId: string | null = null;
    if (this.docker) {
      const name = `grid-rental-${rentalId}`;
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

  async stop(rentalId: bigint) {
    const session = this.sessions.get(rentalId);
    if (!session) return;
    this.sessions.delete(rentalId);
    if (session.containerId) {
      await run("docker", ["rm", "-f", session.containerId]).catch((e: Error) => log(`docker rm failed: ${e.message}`));
      log(`stopped container for rental #${rentalId}`);
    }
  }

  async stopAll() {
    for (const id of [...this.sessions.keys()]) await this.stop(id);
  }
}
