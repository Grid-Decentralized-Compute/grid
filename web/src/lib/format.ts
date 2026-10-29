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

export const fmtDate = (unix: number | bigint) => new Date(Number(unix) * 1000).toLocaleString();

/** viem/wagmi errors carry a one-line `shortMessage`; fall back to the plain message. */
export function shortError(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string };
  return err?.shortMessage ?? err?.message ?? String(e);
}
