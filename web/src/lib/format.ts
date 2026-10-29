import { formatEther } from "viem";

/** ETH (or any 18-decimal token) with at most `maxDigits` decimals and no trailing zeros. */
export function fmtEth(wei: bigint, maxDigits = 5): string {
  const [int, frac = ""] = formatEther(wei).split(".");
  const trimmed = frac.slice(0, maxDigits).replace(/0+$/, "");
  return trimmed ? `${int}.${trimmed}` : int;
}

export const fmtGrid = (wei: bigint) => fmtEth(wei, 2);

export const shortAddr = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export const fmtDate = (unix: number | bigint) =>
  new Date(Number(unix) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** 512 → "512 GB", 2000 → "2 TB" */
export const fmtGb = (gb: number) =>
  gb >= 1000 ? `${Number((gb / 1000).toFixed(1))} TB` : `${gb} GB`;

/** "11th Gen Intel(R) Core(TM) i7-11370H @ 3.30GHz" → "Intel Core i7-11370H" */
export function shortCpu(cpu: string): string {
  return cpu
    .replace(/\((R|TM)\)/gi, "")
    .replace(/\s*@.*$/, "")
    .replace(/\b\d+(st|nd|rd|th) Gen\s+/i, "")
    .replace(/\b(CPU|Processor)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** viem/wagmi errors carry a one-line `shortMessage`; fall back to the plain message. */
export function shortError(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string };
  return err?.shortMessage ?? err?.message ?? String(e);
}
