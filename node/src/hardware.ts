import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import type { MachineMetadata } from "@grid/shared";
import { log } from "./log";

const run = promisify(execFile);

export type Hardware = Pick<MachineMetadata, "gpu" | "vramGb" | "gpuCount" | "cpu" | "ramGb" | "diskGb" | "os">;

/** Describes this machine. With `simulate` it reports a fake GPU so the market can be tried on any laptop. */
export async function probeHardware(simulate: boolean): Promise<Hardware> {
  const base = {
    cpu: os.cpus()[0]?.model?.trim() ?? "unknown CPU",
    ramGb: Math.round(os.totalmem() / 2 ** 30),
    diskGb: await diskGb(),
    os: `${os.platform()} ${os.release()}`,
  };
  if (simulate) return { ...base, gpu: "Simulated RTX 4090", vramGb: 24, gpuCount: 1 };

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
