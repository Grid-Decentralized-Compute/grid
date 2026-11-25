import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import type { MachineMetadata } from "@grid/shared";
import { log } from "./log";

const run = promisify(execFile);

export type Hardware = Pick<MachineMetadata, "gpu" | "vramGb" | "gpuCount" | "cpu" | "ramGb" | "diskGb" | "os">;

/**
 * Describes what this node offers. With `simulate` it reports a fake GPU so the market can be tried on any
 * laptop. Tied to one card (`gpu`), it describes that card alone; sharing the machine with other nodes
 * (`share`), it lists its part of the RAM and disk, which is what a renter's container actually gets.
 */
export async function probeHardware(simulate: boolean, gpu: string | null = null, share = 1): Promise<Hardware> {
  const base = {
    cpu: os.cpus()[0]?.model?.trim() ?? "unknown CPU",
    ramGb: Math.round(os.totalmem() / 2 ** 30 / share),
    diskGb: Math.round((await diskGb()) / share),
    // Only the platform: an exact kernel version next to a public IP tells an attacker which exploits to try.
    os: os.platform(),
  };
  if (simulate) return { ...base, gpu: "Simulated RTX 4090", vramGb: 24, gpuCount: 1 };

  if (gpu !== null) {
    // A node tied to a card must not come up as "CPU only" when that card is missing: it stops instead,
    // so the fault shows in the log and its neighbours on the other cards carry on.
    let stdout: string;
    try {
      ({ stdout } = await run("nvidia-smi", ["-i", gpu, "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]));
    } catch (e) {
      throw new Error(`GRID_GPU=${gpu}: nvidia-smi does not find that GPU (${(e as Error).message.split("\n")[0]}). "nvidia-smi -L" lists the cards and their UUIDs.`);
    }
    const [name, memory] = stdout.trim().split("\n")[0].split(",").map((s) => s.trim());
    if (!name) throw new Error(`GRID_GPU=${gpu}: nvidia-smi printed nothing for that GPU`);
    return { ...base, gpu: name, vramGb: Math.round(Number(memory) / 1024), gpuCount: 1 };
  }

  try {
    const { stdout } = await run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
    const gpus = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(",").map((s) => s.trim()));
    if (gpus.length === 0) throw new Error("nvidia-smi listed no GPUs");
    return { ...base, gpu: gpus[0][0], vramGb: Math.round(Number(gpus[0][1]) / 1024), gpuCount: gpus.length };
  } catch (e) {
    log(`no NVIDIA GPU found (${(e as Error).message.split("\n")[0]}); listing as CPU-only`);
    return { ...base, gpu: "CPU only", vramGb: 0, gpuCount: 0 };
  }
}

async function diskGb(): Promise<number> {
  try {
    const s = await statfs(process.cwd());
    return Math.round((Number(s.bsize) * Number(s.blocks)) / 2 ** 30);
  } catch {
    return 0;
  }
}
