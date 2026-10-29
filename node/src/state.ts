import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Remembers which on-chain machine id belongs to this node so restarts do not list it twice. */
export type State = { chainId: number; market: string; host: string; machineId: string };

export function readState(dir: string): State | null {
  const file = join(dir, "state.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as State;
  } catch {
    return null;
  }
}

export function writeState(dir: string, state: State) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
}
