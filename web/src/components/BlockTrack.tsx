import { type MouseEvent, useEffect, useRef, useState } from "react";
import { useBlockNumber, useChainId, usePublicClient } from "wagmi";

/** Sixty slots, like the minute track on a dial; one per recent block. */
const SLOTS = 60;
const SLOT_PX = 4;
/** How many slots either side the magnifier reaches. */
const LENS_SPREAD = 2.4;

type Block = { n: bigint; txs: number };

/**
 * A quiet row of hairline ticks under the headline. It is a live chart: each tick is one of the
 * latest blocks on the chain the page reads, its height the number of transactions in it.
 */
export function BlockTrack() {
  const chainId = useChainId();
  const client = usePublicClient();
  const { data: head } = useBlockNumber({ watch: true });
  const [blocks, setBlocks] = useState<Block[]>([]);
  const known = useRef<Map<bigint, Block>>(new Map());
  /** The pointer's position along the track, in slots, or null when it is elsewhere. */
  const [pointer, setPointer] = useState<number | null>(null);

  // A different chain has different blocks.
  useEffect(() => {
    known.current = new Map();
    setBlocks([]);
  }, [chainId]);

  useEffect(() => {
    if (!client || head === undefined) return;
    let cancelled = false;
    // First load: the latest sixty blocks. After that, only the head at each poll, so a fast chain
    // costs one request per poll instead of one per block.
    const missing: bigint[] = [];
    if (known.current.size === 0) {
      const from = head >= BigInt(SLOTS - 1) ? head - BigInt(SLOTS - 1) : 0n;
      for (let n = from; n <= head; n++) missing.push(n);
    } else if (!known.current.has(head)) {
      missing.push(head);
    }
    if (missing.length === 0) return;

    Promise.all(
      missing.map((n) =>
        client
          .getBlock({ blockNumber: n })
          .then((b) => ({ n, txs: b.transactions.length }))
          .catch(() => null),
      ),
    ).then((fetched) => {
      if (cancelled) return;
      for (const b of fetched) if (b) known.current.set(b.n, b);
      const kept = [...known.current.values()].sort((a, b) => (a.n < b.n ? -1 : 1)).slice(-SLOTS);
      known.current = new Map(kept.map((b) => [b.n, b]));
      setBlocks(kept);
    });
    return () => {
      cancelled = true;
    };
  }, [client, head]);

  const busiest = Math.max(1, ...blocks.map((b) => b.txs));
  const empty = SLOTS - blocks.length;
  const latest = blocks[blocks.length - 1];
  const hoverIndex = pointer === null ? -1 : Math.round(pointer);
  const hover = hoverIndex >= empty ? blocks[hoverIndex - empty] : undefined;

  /** How strongly the lens acts on slot i: 1 under the pointer, falling off over a few slots. */
  const lens = (i: number) => (pointer === null ? 0 : Math.exp(-((i - pointer) ** 2) / (2 * LENS_SPREAD ** 2)));

  function track(e: MouseEvent<HTMLDivElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    setPointer(Math.min(SLOTS - 1, Math.max(0, (e.clientX - box.left) / SLOT_PX - 0.5)));
  }

  return (
    <figure className="m-0">
      {/* A magnifier: ticks near the pointer grow and darken, the one under it turns steel. Each tick
          sits in a fixed 4 px slot and only transforms, so nothing moves sideways while you sweep. */}
      <div className="flex h-[22px] w-max items-end" onMouseMove={track} onMouseLeave={() => setPointer(null)}>
        {Array.from({ length: SLOTS }, (_, i) => {
          const b = i >= empty ? blocks[i - empty] : undefined;
          const g = lens(i);
          const steel = b ? (hover ? b === hover : b === latest) : false;
          // Square-root scale so one busy block doesn't flatten the rest.
          const h = !b ? (i % 5 === 0 ? 6 : 3) : b.txs === 0 && i % 5 === 0 ? 6 : 3 + Math.round(19 * Math.sqrt(b.txs / busiest));
          return (
            <span
              key={b ? b.n.toString() : `e${i}`}
              aria-hidden="true"
              className="flex h-full w-1 origin-bottom items-end justify-center transition-transform duration-200 ease-out"
              style={{ transform: `scaleY(${1 + 1.6 * g})` }}
            >
              <span
                className={`relative transition-[height,width] duration-200 ease-out ${b ? "tick bg-tick" : "bg-line"}`}
                style={{ height: h, width: 1 + 2 * g }}
              >
                <span
                  className={`absolute inset-0 transition-[opacity,background-color] duration-200 ${steel ? "bg-steel" : "bg-ink"}`}
                  style={{ opacity: steel ? 1 : g * 0.9 }}
                />
              </span>
            </span>
          );
        })}
      </div>
      {/* The footer already names the network and block; this caption says what the ticks measure,
          or reads out the one under the pointer. */}
      <figcaption className="engraved tnum mt-3 text-faint">
        {hover ? (
          <>
            <span className="text-steel">Block {hover.n.toLocaleString("en-US")}</span>
            <span className="mx-2 text-line">/</span>
            {hover.txs} {hover.txs === 1 ? "transaction" : "transactions"}
          </>
        ) : (
          <>
            Transactions per block
            {latest && (
              <>
                <span className="mx-2 text-line">/</span>
                {latest.txs} in the latest
              </>
            )}
          </>
        )}
      </figcaption>
    </figure>
  );
}
