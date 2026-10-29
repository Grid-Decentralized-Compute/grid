import { useEffect, useRef, useState } from "react";
import { useBlockNumber, useChainId, useChains, usePublicClient } from "wagmi";

/** Sixty slots, like the minute track on a dial; one per recent block. */
const SLOTS = 60;

type Block = { n: bigint; txs: number };

/**
 * A quiet row of hairline ticks under the headline. It is a live chart: each tick is one of the
 * latest blocks on the chain the page reads, its height the number of transactions in it.
 */
export function BlockTrack() {
  const chainId = useChainId();
  const chain = useChains().find((c) => c.id === chainId);
  const client = usePublicClient();
  const { data: head } = useBlockNumber({ watch: true });
  const [blocks, setBlocks] = useState<Block[]>([]);
  const known = useRef<Map<bigint, Block>>(new Map());

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

  return (
    <figure className="m-0">
      <div className="flex h-[22px] items-end gap-[3px]" aria-hidden="true">
        {Array.from({ length: empty }, (_, i) => (
          <span key={`e${i}`} className={`w-px bg-line ${i % 5 === 0 ? "h-[6px]" : "h-[3px]"}`} />
        ))}
        {blocks.map((b, i) => {
          const isLatest = i === blocks.length - 1;
          // Square-root scale so one busy block doesn't flatten the rest.
          const h = 3 + Math.round(19 * Math.sqrt(b.txs / busiest));
          return (
            <span
              key={b.n.toString()}
              title={`Block ${b.n.toLocaleString("en-US")} · ${b.txs} transaction${b.txs === 1 ? "" : "s"}`}
              className={`tick w-px transition-[height,background-color] duration-700 ${isLatest ? "bg-steel" : "bg-[#a9aba4]"}`}
              style={{ height: b.txs === 0 && (empty + i) % 5 === 0 ? 6 : h }}
            />
          );
        })}
      </div>
      <figcaption className="engraved tnum mt-3 text-faint">
        {chain?.name ?? "Network"}
        {latest && (
          <>
            <span className="mx-2 text-line">/</span>
            Block {latest.n.toLocaleString("en-US")}
          </>
        )}
      </figcaption>
    </figure>
  );
}
