import { keccak256 } from "viem";
import { MAX_OUTPUT_BYTES, resultUrl } from "@grid/shared";
import { endpointBlocked } from "./hooks";

type Address = `0x${string}`;
type Hex = `0x${string}`;

/** A host that serves task outputs: its address and the URL it registered on-chain. */
export type OutputSource = { host: Address; endpoint: string };

/** What came of asking hosts for a task's output and hashing it against the chain. */
export type OutputCheck =
  | { status: "verified"; host: Address; bytes: Uint8Array<ArrayBuffer>; hash: Hex }
  | { status: "mismatch"; host: Address; hash: Hex }
  | { status: "unreachable" };

/**
 * Fetches a finished task's output from the hosts that agreed on it, one after the other, and keeps
 * the first whose keccak256 equals the result recorded on-chain. A host that answers with something
 * else is remembered, so the caller can tell "nobody answered" from "somebody answered wrongly".
 * The job page and the receipt page both verify outputs through here.
 */
export async function checkTaskOutput(
  swarm: Address,
  jobId: bigint,
  task: number,
  expected: Hex,
  sources: OutputSource[],
): Promise<OutputCheck> {
  let mismatch: OutputCheck | null = null;
  for (const { host, endpoint } of sources) {
    if (!endpoint || endpointBlocked(endpoint)) continue;
    try {
      const res = await fetch(resultUrl(endpoint, swarm, jobId, task), { signal: AbortSignal.timeout(6_000), redirect: "error" });
      if (!res.ok) continue;
      const bytes = await readCapped(res, MAX_OUTPUT_BYTES);
      if (bytes === null) continue;
      const hash = keccak256(bytes);
      if (hash === expected.toLowerCase()) return { status: "verified", host, bytes, hash };
      mismatch ??= { status: "mismatch", host, hash };
    } catch {
      // try the next host that agreed
    }
  }
  return mismatch ?? { status: "unreachable" };
}

/** Reads a response body, giving up past `max` bytes, so a host cannot exhaust the tab's memory. */
export async function readCapped(res: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > max) return null;
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return all;
}
