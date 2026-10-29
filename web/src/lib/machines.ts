import { useCallback, useEffect, useState } from "react";
import type { ContractFunctionReturnType } from "viem";
import { type gridMarketAbi, gpuModel, type MachineMetadata } from "@grid/shared";
import type { Tone } from "../components/ui";
import { endpointBlocked } from "./hooks";

export { gpuModel };

export type Listing = ContractFunctionReturnType<typeof gridMarketAbi, "view", "getListings">[number];

/** What the market knows about one machine: its listing, its parsed metadata and its live status. */
export type MachineView = { item: Listing; meta: MachineMetadata | null; tone: Tone; label: string; free: boolean };

/**
 * A machine's status, from the chain and from its node's /health. The market rows and the GPU
 * index both read it from here, so "free" means the same thing in both places: listed, not
 * rented, reachable, allowed to rent.
 */
export function machineStatus(
  item: Listing,
  meta: MachineMetadata | null,
  health: { isSuccess: boolean; isPending: boolean },
): { tone: Tone; label: string; free: boolean } {
  const { machine, rentable } = item;
  // A host behind NAT has no reachable SSH port: it takes swarm work only.
  const [tone, label]: [Tone, string] =
    meta?.p2p?.direct === false
      ? ["off", "Swarm only"]
      : !machine.available
        ? ["off", "Paused"]
        : machine.activeRental !== 0n
          ? ["busy", "Rented"]
          : endpointBlocked(meta?.endpoint)
            ? ["off", "Unreachable"]
            : health.isPending
              ? ["off", "Checking"]
              : !health.isSuccess
                ? ["off", "Offline"]
                : !rentable
                  ? ["off", "Needs bond"]
                  : ["ok", "Available"];
  return { tone, label, free: label === "Available" };
}

/** The GPU index groups machines by model and memory size; this is that group's id. */
export function groupKey(meta: MachineMetadata | null): string {
  const model = gpuModel(meta);
  return `${model}|${model === "CPU only" ? 0 : (meta?.vramGb ?? 0)}`;
}

/** Price per GPU-hour, so a two-GPU machine compares fairly with a one-GPU machine. */
export const pricePerGpu = (v: MachineView) => v.item.machine.pricePerHour / BigInt(Math.max(1, v.meta?.gpuCount ?? 1));

export type GpuGroup = {
  key: string;
  model: string;
  vramGb: number;
  total: number;
  free: number;
  /** Cheapest per-GPU price among free machines, or among all of them when none is free. */
  from: bigint;
};

/** One group per GPU model and memory size, models with free machines first, larger GPUs first. */
export function gpuGroups(views: MachineView[]): GpuGroup[] {
  const groups = new Map<string, GpuGroup & { fromFree: bigint | null; fromAny: bigint }>();
  for (const v of views) {
    const model = gpuModel(v.meta);
    const vramGb = model === "CPU only" ? 0 : (v.meta?.vramGb ?? 0);
    const key = groupKey(v.meta);
    const price = pricePerGpu(v);
    const g = groups.get(key) ?? { key, model, vramGb, total: 0, free: 0, from: 0n, fromFree: null, fromAny: price };
    g.total++;
    if (price < g.fromAny) g.fromAny = price;
    if (v.free) {
      g.free++;
      if (g.fromFree === null || price < g.fromFree) g.fromFree = price;
    }
    groups.set(key, g);
  }
  return [...groups.values()]
    .map(({ fromFree, fromAny, ...g }) => ({ ...g, from: fromFree ?? fromAny }))
    .sort((a, b) =>
      (a.model === "CPU only") !== (b.model === "CPU only")
        ? a.model === "CPU only"
          ? 1
          : -1
        : (a.free > 0) !== (b.free > 0)
          ? a.free > 0
            ? -1
            : 1
          : b.vramGb - a.vramGb || (a.from < b.from ? -1 : 1),
    );
}

export type Filters = { gpu: string | null; vram: number; free: boolean; sort: "price" | "vram" };
export const VRAM_STEPS = [0, 16, 24, 48, 80];
const DEFAULTS: Filters = { gpu: null, vram: 0, free: false, sort: "price" };

export const filtersActive = (f: Filters) => f.gpu !== null || f.vram > 0 || f.free;

export function applyFilters(views: MachineView[], f: Filters): MachineView[] {
  const shown = views.filter(
    (v) =>
      (f.gpu === null || groupKey(v.meta) === f.gpu) &&
      (v.meta?.vramGb ?? 0) >= f.vram &&
      (!f.free || v.free),
  );
  // Free machines first; then by price per GPU-hour, or by memory, largest first.
  return shown.sort((a, b) => {
    if (a.free !== b.free) return a.free ? -1 : 1;
    if (f.sort === "vram") {
      const d = (b.meta?.vramGb ?? 0) - (a.meta?.vramGb ?? 0);
      if (d !== 0) return d;
    }
    const pa = pricePerGpu(a);
    const pb = pricePerGpu(b);
    return pa === pb ? 0 : pa < pb ? -1 : 1;
  });
}

/**
 * Filters kept in the query string (?gpu=RTX%204090|24&vram=24&free=1&sort=vram), so a filtered
 * market is a link you can share. Changes replace the history entry instead of adding one.
 */
export function useFilters(): [Filters, (patch: Partial<Filters>) => void, () => void] {
  const [filters, setFilters] = useState<Filters>(() => readFilters());

  useEffect(() => {
    const sync = () => setFilters(readFilters());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  const update = useCallback((patch: Partial<Filters>) => {
    setFilters((current) => {
      const next = { ...current, ...patch };
      writeFilters(next);
      return next;
    });
  }, []);
  const clear = useCallback(() => update({ gpu: null, vram: 0, free: false }), [update]);
  return [filters, update, clear];
}

function readFilters(): Filters {
  const q = new URLSearchParams(window.location.search);
  const vram = Number(q.get("vram"));
  return {
    gpu: q.get("gpu") || DEFAULTS.gpu,
    vram: VRAM_STEPS.includes(vram) ? vram : DEFAULTS.vram,
    free: q.get("free") === "1",
    sort: q.get("sort") === "vram" ? "vram" : DEFAULTS.sort,
  };
}

function writeFilters(f: Filters) {
  const q = new URLSearchParams();
  if (f.gpu) q.set("gpu", f.gpu);
  if (f.vram) q.set("vram", String(f.vram));
  if (f.free) q.set("free", "1");
  if (f.sort !== DEFAULTS.sort) q.set("sort", f.sort);
  const search = q.toString();
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`);
}
