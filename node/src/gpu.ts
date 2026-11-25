import os from "node:os";
import type { Config } from "./config";

/**
 * One machine, several GPUs. A Grid node can be tied to a single card (GRID_GPU), so a rig with six cards
 * runs six hosts, each with its own wallet, listing and bond. This file holds what those nodes need to
 * live side by side: which card docker hands a container, the label that marks a node's own containers,
 * and the slice of memory and CPU each node's containers may take.
 */

/**
 * A GPU as nvidia-smi and docker name it: an index (0, 1, ...) or a UUID (GPU-...). A UUID keeps pointing
 * at the same card when another one is moved or removed; an index does not.
 */
export const GPU_ID = /^([0-9]{1,3}|GPU-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/** The docker flag that gives a container this node's GPU: every card when the node is not tied to one. */
export const gpuArgs = (device: string | null): string[] => ["--gpus", device === null ? "all" : `device=${device}`];

/** Docker label carried by every container a node starts. */
export const hostLabel = (address: string) => `grid.host=${address.toLowerCase()}`;

/** True when this node shares its machine with other Grid nodes. */
export const sharesMachine = (config: Pick<Config, "gpu" | "share">) => config.gpu !== null || config.share > 1;

/**
 * Narrows a `docker ps` to this node's own containers when it shares the machine, so cleaning up after a
 * restart never removes a neighbour's running rental or task. Alone on the machine nothing is narrowed,
 * and containers left by an older version of the node are still found.
 */
export const ownFilter = (config: Pick<Config, "gpu" | "share" | "hostAddress">): string[] =>
  sharesMachine(config) ? ["--filter", `label=${hostLabel(config.hostAddress)}`] : [];

/** Memory (MiB) and CPUs for one of this node's containers when `share` nodes divide the machine. */
export function slice(share: number, totalMem = os.totalmem(), cpus = os.cpus().length) {
  const memMb = Math.max(1024, Math.floor((totalMem * 0.8) / share / 2 ** 20));
  return { memMb, cpus: Math.max(1, Math.floor((cpus - 1) / share)) };
}
