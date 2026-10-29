import { type PointerEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";

/**
 * The network, drawn like an engraved plate: machines on a lattice joined by peer links, relays
 * carrying machines that sit behind home routers, and renters' jobs lighting hosts across it.
 * Jobs start in different places and overlap, because no machine or server sits in the middle.
 *
 * On load the machines come online in a ripple from a relay, the way a node joins through the
 * peers it already knows. Under the pointer the engraving catches the light, a renter snaps to the
 * nearest cell and shows the hosts it would reach, and a click sends the job.
 *
 * The drawing is seeded, so it is the same on every load. Motion is CSS (index.css: `.job`, `.boot`);
 * with reduced motion three jobs are shown still and nothing animates.
 */

const COLS = 15;
const ROWS = 11;
const PITCH = 24;
const PAD = 12;
const W = PAD * 2 + (COLS - 1) * PITCH;
const H = PAD * 2 + (ROWS - 1) * PITCH;
/** Seconds for one full loop; jobs are spread evenly across it. Must match `.job` in index.css. */
const CYCLE = 14;
/** How long a job sent by a click stays on the plate. */
const SENT_MS = 6400;
const NODE = 7;
/** Milliseconds per cell of distance from the first relay, for the boot ripple. */
const RIPPLE = 46;

type Cell = { c: number; r: number };
type Pt = Cell & { x: number; y: number };
type Job = { renter: Pt; hosts: Pt[]; tie: Pt | null; direct: boolean; still: boolean };

/** Where each job's renter sits, its size (1 = a direct rental), and whether a tie-break runs. */
const JOBS: { at: [number, number]; size: number; tie: boolean }[] = [
  { at: [3, 2], size: 5, tie: true },
  { at: [11, 8], size: 1, tie: false },
  { at: [9, 2], size: 4, tie: false },
  { at: [2, 8], size: 6, tie: true },
  { at: [12, 4], size: 3, tie: false },
  { at: [6, 6], size: 1, tie: false },
];
/** The jobs drawn when motion is reduced: one in each part of the plate. */
const STILL = [0, 1, 4];
const RELAYS: [number, number][] = [
  [12, 1],
  [5, 9],
];

const at = (c: number, r: number): Pt => ({ c, r, x: PAD + c * PITCH, y: PAD + r * PITCH });
const key = (p: Cell) => p.r * COLS + p.c;
const id = (p: Cell) => `${p.c},${p.r}`;
const dist = (a: Cell, b: Cell) => Math.hypot(a.c - b.c, a.r - b.r);

/** Hosts near a renter, nearest first: never the four machines touching its cell, so every wire crosses the plate. */
function near(renter: Pt, machines: Pt[], skip: (p: Pt) => boolean) {
  return machines
    .filter((p) => !skip(p))
    .map((p) => ({ p, d: dist(p, renter) }))
    .filter(({ d }) => d > 1 && d <= 4.4)
    .sort((a, b) => a.d - b.d)
    .map(({ p }) => p);
}

function build(seed: number) {
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

  // Machines on the lattice, with gaps.
  const grid = new Map<number, Pt>();
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (rand() < 0.66) grid.set(r * COLS + c, at(c, r));

  const relays = RELAYS.map(([c, r]) => {
    const p = at(c, r);
    grid.set(key(p), p);
    return p;
  });
  const isRelay = (p: Pt) => relays.includes(p);

  // Machines behind routers: no public address, so their only link is a relay.
  const behind = new Map<number, { p: Pt; relay: Pt }>();
  for (const relay of relays) {
    const ring = [...grid.values()]
      .filter((p) => !isRelay(p) && Math.max(Math.abs(p.c - relay.c), Math.abs(p.r - relay.r)) === 2)
      .sort(() => rand() - 0.5)
      .slice(0, 3);
    for (const p of ring) behind.set(key(p), { p, relay });
  }

  // Peer links between lattice neighbours.
  const links: [Pt, Pt][] = [];
  for (const p of grid.values()) {
    if (behind.has(key(p))) continue;
    const right = p.c + 1 < COLS ? grid.get(key({ c: p.c + 1, r: p.r })) : undefined;
    const down = grid.get(key({ c: p.c, r: p.r + 1 }));
    for (const q of [right, down]) if (q && !behind.has(key(q)) && rand() < 0.62) links.push([p, q]);
  }

  const machines = [...grid.values()];
  // Renters are people, not machines: they sit in the middle of a cell, over the network.
  const used = new Set<number>();
  const jobs: Job[] = JOBS.map((spec, i) => {
    const renter = at(spec.at[0] + 0.5, spec.at[1] + 0.5);
    const close = near(renter, machines, (p) => isRelay(p) || used.has(key(p)));
    const pool = close.slice(0, spec.size === 1 ? 3 : spec.size + 5);
    const picked = pool.sort(() => rand() - 0.5);
    const hosts = picked.slice(0, spec.size);
    const tie = spec.tie ? (picked[spec.size] ?? null) : null;
    for (const p of tie ? [...hosts, tie] : hosts) used.add(key(p));
    return { renter, hosts, tie, direct: spec.size === 1, still: STILL.includes(i) };
  });

  return { machines, relays, isRelay, behind: [...behind.values()], links, jobs };
}

const PLATE = build(20261029);
const ORIGIN = PLATE.relays[0];
const delay = (p: Cell) => `${Math.round(dist(p, ORIGIN) * RIPPLE)}ms`;

/** The job a renter in this cell would send: three to five hosts, sometimes a tie-break. Same cell, same job. */
function jobAt(cell: Cell): Job {
  const renter = at(cell.c + 0.5, cell.r + 0.5);
  const close = near(renter, PLATE.machines, PLATE.isRelay);
  const size = 3 + ((cell.c * 7 + cell.r * 3) % 3);
  const tie = (cell.c + 2 * cell.r) % 3 === 0 ? (close[size] ?? null) : null;
  return { renter, hosts: close.slice(0, size), tie, direct: false, still: false };
}

const square = (p: Pt, size = NODE) => ({ x: p.x - size / 2, y: p.y - size / 2, width: size, height: size });
const wire = (a: Pt, b: Pt) => `M${a.x} ${a.y}L${b.x} ${b.y}`;

export function NetworkPlate({ className = "" }: { className?: string }) {
  const { machines, relays, behind, links, jobs } = PLATE;
  const uid = useId().replace(/:/g, "");
  const svg = useRef<SVGSVGElement>(null);
  const light = useRef<SVGCircleElement>(null);
  const [cell, setCell] = useState<Cell | null>(null);
  const [sent, setSent] = useState<{ n: number; job: Job }[]>([]);
  const counter = useRef(0);
  const preview = useMemo(() => (cell ? jobAt(cell) : null), [cell]);

  // Jobs sent by a click leave once their run is over.
  useEffect(() => {
    if (sent.length === 0) return;
    const t = setTimeout(() => setSent((s) => s.slice(1)), SENT_MS);
    return () => clearTimeout(t);
  }, [sent]);

  function locate(e: PointerEvent<SVGSVGElement>) {
    const ctm = svg.current?.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    const c = Math.min(COLS - 2, Math.max(0, Math.floor((p.x - PAD) / PITCH)));
    const r = Math.min(ROWS - 2, Math.max(0, Math.floor((p.y - PAD) / PITCH)));
    return { x: p.x, y: p.y, cell: { c, r } };
  }

  function move(e: PointerEvent<SVGSVGElement>) {
    const at = locate(e);
    if (!at) return;
    // The light follows the pointer every frame without re-rendering the plate.
    light.current?.setAttribute("cx", String(at.x));
    light.current?.setAttribute("cy", String(at.y));
    if (e.pointerType === "mouse" && (!cell || cell.c !== at.cell.c || cell.r !== at.cell.r)) setCell(at.cell);
  }

  function send(e: PointerEvent<SVGSVGElement>) {
    const at = locate(e);
    if (!at) return;
    const job = jobAt(at.cell);
    setSent((s) => [...s.slice(-3), { n: counter.current++, job }]);
  }

  const hovering = cell !== null;

  return (
    <figure className={`m-0 ${className}`}>
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        className="plate block h-auto w-full cursor-crosshair touch-manipulation select-none"
        role="img"
        aria-label="The Grid network: machines joined by peer links, relays for machines behind routers, and renters' jobs running on hosts in different parts of the network."
        onPointerMove={move}
        onPointerLeave={() => setCell(null)}
        onPointerUp={send}
      >
        <defs>
          <radialGradient id={`${uid}-glow`}>
            <stop offset="0" stopColor="#fff" stopOpacity="1" />
            <stop offset="0.55" stopColor="#fff" stopOpacity="0.55" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <mask id={`${uid}-light`} maskUnits="userSpaceOnUse" x={0} y={0} width={W} height={H}>
            <circle ref={light} cx={-200} cy={-200} r={78} fill={`url(#${uid}-glow)`} />
          </mask>
        </defs>

        {/* The engraving. */}
        <g className="stroke-line" strokeWidth={1}>
          {links.map(([a, b]) => (
            <path key={`${id(a)}-${id(b)}`} d={wire(a, b)} pathLength={1} className="boot-link" style={{ ["--b" as string]: delay(a) }} />
          ))}
        </g>
        <g className="stroke-mark-off" strokeWidth={1} strokeDasharray="2 3">
          {behind.map(({ p, relay }) => (
            <line key={id(p)} x1={p.x} y1={p.y} x2={relay.x} y2={relay.y} className="boot-fade" style={{ ["--b" as string]: delay(p) }} />
          ))}
        </g>
        <g className="fill-dial stroke-mark-off" strokeWidth={1}>
          {machines.map((p) => (
            <rect key={id(p)} {...square(p)} rx={1.25} className="boot" style={{ ["--b" as string]: delay(p) }} />
          ))}
        </g>
        {relays.map((p) => (
          <g key={id(p)} strokeWidth={1} className="boot" style={{ ["--b" as string]: delay(p) }}>
            <rect {...square(p, 13)} rx={2} className="fill-dial stroke-faint" />
            <rect {...square(p)} rx={1.25} className="fill-faint stroke-faint" />
          </g>
        ))}

        {/* The same engraving, darker, seen only where the light falls. */}
        <g
          mask={`url(#${uid}-light)`}
          className={`pointer-events-none transition-opacity duration-500 ${hovering ? "opacity-100" : "opacity-0"}`}
          strokeWidth={1}
        >
          <g className="stroke-faint">
            {links.map(([a, b]) => (
              <line key={`${id(a)}-${id(b)}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
            ))}
          </g>
          <g className="fill-none stroke-muted">
            {machines.map((p) => (
              <rect key={id(p)} {...square(p)} rx={1.25} />
            ))}
          </g>
        </g>

        {/* Jobs running on their own. They step back while you aim one of yours. */}
        <g className={`transition-opacity duration-500 ${hovering ? "opacity-30" : "opacity-100"}`}>
          <g className="ambient-in">
            {jobs.map((job, i) => (
              <JobMark
                key={id(job.renter)}
                job={job}
                className={job.still ? "job still" : "job"}
                offset={`${(-i * CYCLE) / jobs.length}s`}
              />
            ))}
          </g>
        </g>

        {/* Where a click would send a job, and the hosts it would reach. */}
        {preview && (
          <g className="pointer-events-none" aria-hidden="true">
            {preview.hosts.map((h) => (
              <line key={`w${id(h)}`} x1={preview.renter.x} y1={preview.renter.y} x2={h.x} y2={h.y} className="stroke-steel-edge" strokeWidth={1} strokeDasharray="1.5 2.5" />
            ))}
            {preview.hosts.map((h) => (
              <rect key={`h${id(h)}`} {...square(h, 12)} rx={2} className="fill-none stroke-steel" strokeWidth={1} />
            ))}
            <circle cx={preview.renter.x} cy={preview.renter.y} r={5.5} className="fill-dial stroke-steel" strokeWidth={1.25} />
            <circle cx={preview.renter.x} cy={preview.renter.y} r={1.6} className="fill-steel" />
          </g>
        )}

        {sent.map(({ n, job }) => (
          <JobMark key={n} job={job} className="job once" offset="0s" />
        ))}
      </svg>
      <figcaption className="engraved mt-3 grid grid-cols-2 gap-x-5 gap-y-1.5 text-faint">
        <Key glyph={<circle cx={5} cy={5} r={3.6} className="fill-none stroke-ink" strokeWidth={1.2} />}>Renter</Key>
        <Key glyph={<rect x={1.5} y={1.5} width={7} height={7} rx={1.25} className="fill-steel" />}>Host at work</Key>
        <Key glyph={<rect x={1.5} y={1.5} width={7} height={7} rx={1.25} className="fill-gold" />}>Tie-break</Key>
        <Key
          glyph={
            <>
              <rect x={0.5} y={0.5} width={9} height={9} rx={1.5} className="fill-none stroke-faint" strokeWidth={1} />
              <rect x={3} y={3} width={4} height={4} rx={0.75} className="fill-faint" />
            </>
          }
        >
          Relay
        </Key>
      </figcaption>
    </figure>
  );
}

function JobMark({ job, className, offset }: { job: Job; className: string; offset: string }) {
  return (
    <g className={`pointer-events-none ${className}`} style={{ ["--d" as string]: offset }}>
      {job.hosts.map((h) => (
        <path
          key={id(h)}
          d={wire(job.renter, h)}
          pathLength={1}
          className={`wire fill-none ${job.direct ? "stroke-steel" : "stroke-steel-soft"}`}
          strokeWidth={job.direct ? 1.5 : 1}
        />
      ))}
      {job.tie && <path d={wire(job.renter, job.tie)} pathLength={1} className="wire tie fill-none stroke-gold" strokeWidth={1} />}
      {job.hosts.map((h) => (
        <rect key={id(h)} {...square(h)} rx={1.25} className="lit fill-steel stroke-steel" strokeWidth={1} />
      ))}
      {job.tie && <rect {...square(job.tie)} rx={1.25} className="lit tie fill-gold stroke-gold" strokeWidth={1} />}
      <circle cx={job.renter.x} cy={job.renter.y} r={5.5} className="fill-dial stroke-ink" strokeWidth={1.25} />
      <circle cx={job.renter.x} cy={job.renter.y} r={1.6} className="fill-ink" />
    </g>
  );
}

function Key({ glyph, children }: { glyph: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <svg viewBox="0 0 10 10" className="size-[10px] shrink-0" aria-hidden="true">
        {glyph}
      </svg>
      {children}
    </span>
  );
}
