const HOUR_MS = 3_600_000;
/** The most one advance() call adds. The node calls it every few seconds or minutes, so a longer gap means it was asleep or stalled, not idle. */
const MAX_GAP_MS = 10 * 60_000;

/**
 * The price after `hours` idle hours: each full hour takes `stepPercent` of the current price off,
 * and the result never goes below `floor`.
 */
export function decayedPrice(list: bigint, floor: bigint, stepPercent: number, hours: number): bigint {
  const stepBps = BigInt(Math.round(stepPercent * 100));
  if (stepBps === 0n || floor >= list) return list;
  let price = list;
  for (let h = 0; h < hours && price > floor; h++) price = (price * (10_000n - stepBps)) / 10_000n;
  return price > floor ? price : floor;
}

/**
 * A price that drops while the machine sits idle and is back at `list` after reset(). Only time
 * reported through advance(true) counts as idle, so hours when the machine is closed by its schedule
 * or rented do not lower it.
 */
export class IdlePrice {
  private idleMs = 0;
  private last: number;

  constructor(
    private readonly list: bigint,
    private readonly floor: bigint,
    private readonly stepPercent: number,
    now = Date.now(),
  ) {
    this.last = now;
  }

  /** Adds the time since the last call to the idle time when `idle` (a long gap counts as at most ten minutes), and ignores it otherwise. */
  advance(idle: boolean, now = Date.now()) {
    if (idle) this.idleMs += Math.min(MAX_GAP_MS, Math.max(0, now - this.last));
    this.last = now;
  }

  /** Something was rented or claimed: the price returns to the list price and the idle count starts again. */
  reset(now = Date.now()) {
    this.idleMs = 0;
    this.last = now;
  }

  /** Full idle hours so far. */
  get hours(): number {
    return Math.floor(this.idleMs / HOUR_MS);
  }

  /** The price to ask right now. */
  get current(): bigint {
    return decayedPrice(this.list, this.floor, this.stepPercent, this.hours);
  }
}
