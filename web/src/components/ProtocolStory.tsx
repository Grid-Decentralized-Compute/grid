import { type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { gsap, reducedMotion, ScrollTrigger, scrollToTarget } from "../lib/motion";
import { Code } from "./ui";

/**
 * How a swarm job and then a direct rental move through Grid, told one paragraph at a time. The
 * drawing stays in view while the text scrolls; each paragraph moves it to the step it describes,
 * scrubbed by the scroll position so it can be read forwards and backwards.
 *
 * The drawing uses the network plate's engraving: machines on a lattice, renters between them, and
 * under them the chain with the two markets as sub-dials. A dial's arc is a power reserve: the ETH
 * (or swarm runs) the contract holds for renters, filling when they pay and running down as hosts
 * are paid and refunds go back.
 */

type Step = { group: "Direct" | "Swarm"; call?: string; note?: string; text: ReactNode };

const STEPS: Step[] = [
  {
    group: "Swarm",
    call: "postJob",
    text: (
      <>
        A swarm job is a container and a list of inputs, one per task. You post it to SwarmMarket with the ETH for three
        runs of every task.
      </>
    ),
  },
  {
    group: "Swarm",
    call: "submit",
    text: (
      <>
        Hosts whose machines are idle claim tasks on short leases, run them and keep the output. Each submits a sealed
        hash of it and opens the seal only once the other host on the task has submitted too, so neither can copy the
        other.
      </>
    ),
  },
  {
    group: "Swarm",
    call: "reveal",
    text: (
      <>
        Every task runs on two different hosts. When their hashes match, both are paid. When they differ, a third host
        runs it: the two that agree are paid and the odd one out is recorded as a fault against its bond.
      </>
    ),
  },
  {
    group: "Swarm",
    call: "closeJob",
    text: (
      <>
        A lease that runs out is handed to another host, so no single machine can stall the job. When the job is done
        you close it and the runs that were not needed come back to you.
      </>
    ),
  },
  {
    group: "Swarm",
    note: "results",
    text: (
      <>
        Results are fetched straight from the hosts that produced them and checked against the hashes on-chain, so a
        result shown here is one two hosts agreed on. Tasks must be deterministic, and a job's inputs are public.
      </>
    ),
  },
  {
    group: "Direct",
    call: "listMachine",
    text: (
      <>
        A host's node registers the machine with <Code>listMachine</Code>, giving an hourly price in ETH and the address
        the node can be reached at.
      </>
    ),
  },
  {
    group: "Direct",
    call: "rent",
    text: (
      <>
        To rent it, you call <Code>rent</Code> with the number of hours and send the ETH for them. The node sees the
        rental on-chain, starts a container for you, and lets your SSH key in once you sign a message proving the rental
        is yours.
      </>
    ),
  },
  {
    group: "Direct",
    call: "endRental",
    text: (
      <>
        A rental ends when either of you calls <Code>endRental</Code>, or when anyone does after the paid hours run out.
        The host is paid for every minute that was started and you are refunded the remainder. Both of you collect with{" "}
        <Code>withdraw</Code>. The contract has no owner and charges no fee.
      </>
    ),
  },
  {
    group: "Direct",
    note: "host offline",
    text: (
      <>
        A direct rental depends on one machine. If its host goes offline, the session ends with it; you pay only for the
        minutes that were started, and anything on the machine is lost.
      </>
    ),
  },
];

// The drawing, in viewBox units.
const W = 480;
const H = 416;
const PITCH = 36;
const PAD = 24;
const COLS = 13;
const ROWS = 7;
const NODE = 7;
const RAIL = 318;
const DIAL = 33;
const ARC = 26;

type Pt = { x: number; y: number };
const at = (c: number, r: number): Pt => ({ x: PAD + c * PITCH, y: PAD + r * PITCH });
const GM: Pt = { x: 150, y: RAIL };
const SM: Pt = { x: 330, y: RAIL };
/** Where a transaction meets a dial. */
const top = (d: Pt): Pt => ({ x: d.x, y: d.y - DIAL });

// The direct rental.
const HOST = at(4, 1);
const RENTER = at(1.5, 3.5);
// The swarm job: its owner sits elsewhere on the plate, and its four tasks run on hosts across it.
const OWNER = at(8.5, 3.5);
const PAIRS: [Pt, Pt][] = [
  [at(6, 1), at(11, 0)],
  [at(12, 1), at(7, 5)],
  [at(10, 6), at(5, 4)], // these two disagree; at(5, 4) is the odd one out
  [at(9, 1), at(11, 5)], // at(11, 5)'s lease runs out
];
const TIE = at(12, 6);
const STANDBY = at(10, 2);
const ODD = PAIRS[2][1];
const LAPSED = PAIRS[3][1];
/** The host of each task whose output the owner downloads at the end. */
const SOURCES = [PAIRS[0][0], PAIRS[1][0], PAIRS[2][0], PAIRS[3][0]];
const CHIPS = [0, 1, 2, 3].map((i) => ({ x: OWNER.x + 14 + i * 9, y: OWNER.y - 3 }));

const cellKey = (p: Pt) => `${p.x},${p.y}`;
const STORY = new Set([HOST, ...PAIRS.flat(), TIE, STANDBY].map(cellKey));
/** Cells kept empty so labels can sit there. */
const CLEAR = new Set([at(5, 1), at(5, 5), at(4, 0)].map(cellKey));

function lattice(seed: number) {
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const grid = new Map<string, Pt>();
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const p = at(c, r);
      const k = cellKey(p);
      if (STORY.has(k) || (!CLEAR.has(k) && rand() < 0.5)) grid.set(k, p);
    }
  const links: [Pt, Pt][] = [];
  for (const p of grid.values())
    for (const q of [grid.get(cellKey({ x: p.x + PITCH, y: p.y })), grid.get(cellKey({ x: p.x, y: p.y + PITCH }))])
      if (q && rand() < 0.55) links.push([p, q]);
  return { machines: [...grid.values()], links };
}
const LATTICE = lattice(20261030);

const wire = (a: Pt, b: Pt) => `M${a.x} ${a.y}L${b.x} ${b.y}`;
const sq = (p: Pt, size = NODE) => ({ x: p.x - size / 2, y: p.y - size / 2, width: size, height: size });
const ARC_FROM = 150;
const ARC_TO = 390;
const polar = (d: Pt, r: number, deg: number) => ({ x: d.x + r * Math.cos((deg * Math.PI) / 180), y: d.y + r * Math.sin((deg * Math.PI) / 180) });
const arcPath = (d: Pt) => {
  const a = polar(d, ARC, ARC_FROM);
  const b = polar(d, ARC, ARC_TO);
  return `M${a.x} ${a.y}A${ARC} ${ARC} 0 1 1 ${b.x} ${b.y}`;
};
const ENGRAVED = { fontWeight: 500, letterSpacing: "0.16em" } as const;

/** Scroll per step, in small-viewport heights: room to play the step and then to read it. */
const SCROLL_PER_STEP = 55;

export function ProtocolStory() {
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const trigger = useRef<ScrollTrigger | null>(null);
  const [active, setActive] = useState(0);
  const step = STEPS[active];
  const ofGroup = STEPS.filter((s) => s.group === step.group);
  const uid = useId().replace(/:/g, "");

  useLayoutEffect(() => {
    const el = root.current;
    const pinned = stage.current;
    if (!el || !pinned) return;
    const ctx = gsap.context(() => {
      const tl = choreograph(gsap.utils.selector(el));
      const n = STEPS.length;
      const seek = (progress: number) => {
        // Each step plays over the first 70% of its stretch of scroll, then holds while it is read.
        const at = progress * n;
        const i = Math.min(n - 1, Math.floor(at));
        const time = i + Math.min(1, (at - i) / 0.7);
        // The step playing (or just played) is the one shown; at a boundary that is the earlier one.
        setActive(Math.min(n - 1, Math.max(0, Math.ceil(time) - 1)));
        if (reducedMotion()) tl.time(Math.min(n, Math.ceil(time)));
        else gsap.to(tl, { time, duration: 0.7, ease: "power3.out", overwrite: true });
      };
      // The stage is CSS-sticky; the trigger covers exactly the scroll it stays stuck for.
      trigger.current = ScrollTrigger.create({
        trigger: el,
        start: () => `top top+=${parseFloat(getComputedStyle(pinned).top) || 0}`,
        end: () => `+=${el.offsetHeight - pinned.offsetHeight}`,
        invalidateOnRefresh: true,
        onUpdate: (self) => seek(self.progress),
        onRefresh: (self) => seek(self.progress),
      });
    }, el);
    // Heights depend on the fonts; measure again once they are in.
    void document.fonts?.ready.then(() => ScrollTrigger.refresh());
    return () => {
      trigger.current = null;
      ctx.revert();
    };
  }, []);

  /** Scrolls to the point where step i has just finished playing. */
  const goTo = (i: number) => {
    const t = trigger.current;
    if (t) scrollToTarget(t.start + ((i + 0.72) / STEPS.length) * (t.end - t.start), true);
  };

  return (
    // The stage stays stuck at the top, text and drawing together, while the spacer after it scrolls
    // by. (A spacer, not padding: sticky elements only travel within their container's content box.)
    <div ref={root} data-story className="relative mt-14">
      <div
        ref={stage}
        className="sticky top-0 z-10 grid gap-y-5 bg-dial pt-3 lg:top-24 lg:grid-cols-[minmax(0,25rem)_minmax(0,1fr)] lg:gap-x-16 lg:pt-0"
      >
        <div className="max-lg:order-2">
          <h2 className="engraved relative pb-2 leading-5 text-ink">
            <Flip key={step.group} text={step.group} className="engraved text-ink" />
            <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-px bg-rule" />
          </h2>
          <div className="mt-5 grid">
            {STEPS.map((s, i) => (
              <p
                key={i}
                className={`relative !mt-0 [grid-area:1/1] transition-[opacity,transform] duration-500 ease-[cubic-bezier(0.2,0.7,0.2,1)] ${
                  i === active
                    ? "translate-y-0 opacity-100 delay-150"
                    : `pointer-events-none opacity-0 ${i < active ? "-translate-y-2" : "translate-y-2"}`
                }`}
              >
                <span aria-hidden="true" className="absolute -left-4 top-[0.55em] h-3.5 w-[2px] bg-steel max-lg:hidden" />
                {s.text}
              </p>
            ))}
          </div>
          <div className="mt-6 flex items-center" role="group" aria-label="Steps">
            {STEPS.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => goTo(i)}
                aria-label={`${s.group}, step ${STEPS.filter((x) => x.group === s.group).indexOf(s) + 1}`}
                aria-current={i === active ? "step" : undefined}
                className={`group/tick flex h-6 items-end px-[5px] ${i > 0 && STEPS[i - 1].group !== s.group ? "ml-3" : ""}`}
              >
                <span
                  className={`block h-3 w-[2px] origin-bottom transition-[transform,background-color] duration-500 ease-[cubic-bezier(0.2,0.7,0.2,1)] ${
                    i === active ? "scale-y-100 bg-steel" : `scale-y-50 group-hover/tick:scale-y-75 ${i < active ? "bg-faint" : "bg-mark-off"}`
                  }`}
                />
              </button>
            ))}
          </div>
        </div>

        <figure className="m-0 lg:col-start-2 lg:row-start-1" aria-label="A drawing of the step described in the text">
          <figcaption className="mb-3 flex items-baseline justify-between gap-4 border-b border-line pb-2 leading-5">
            <span className="engraved text-faint">
              Step <span className="tnum">{ofGroup.indexOf(step) + 1}</span> of {ofGroup.length}
            </span>
            <Flip
              key={active}
              text={step.call ? `${step.call}()` : (step.note ?? "")}
              className={step.call ? "font-mono text-[12.5px] text-steel" : "engraved text-faint"}
            />
          </figcaption>
          <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto max-h-[44svh] w-full select-none lg:max-h-[calc(100svh-11rem)]" aria-hidden="true">
          <defs>
            <linearGradient id={`${uid}-fade`} x1="0" x2="1">
              <stop offset="0" stopColor="#fff" stopOpacity="0" />
              <stop offset="0.1" stopColor="#fff" stopOpacity="1" />
              <stop offset="0.9" stopColor="#fff" stopOpacity="1" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </linearGradient>
            <mask id={`${uid}-edges`} maskUnits="userSpaceOnUse" x={0} y={0} width={W} height={H}>
              <rect width={W} height={H} fill={`url(#${uid}-fade)`} />
            </mask>
          </defs>

          {/* The chain: blocks keep arriving while the story plays. */}
          <text x={0} y={RAIL - 9} className="fill-faint" style={{ ...ENGRAVED, fontSize: 7.5 }}>
            ROBINHOOD CHAIN
          </text>
          <line x1={0} x2={W} y1={RAIL} y2={RAIL} className="stroke-line" strokeWidth={1} />
          <g mask={`url(#${uid}-edges)`}>
            <g data-k="blocks" className="stroke-tick" strokeWidth={1.25}>
              {Array.from({ length: 110 }, (_, i) => (
                <line key={i} x1={i * 8 + 2} x2={i * 8 + 2} y1={H - 18} y2={H - 9} />
              ))}
            </g>
          </g>
          <Dial at={GM} name="GridMarket" unit="ETH held" k="gm" />
          <Dial at={SM} name="SwarmMarket" unit="runs held" k="sm" />

          {/* The network's engraving. */}
          <g className="stroke-line" strokeWidth={1}>
            {LATTICE.links.map(([a, b]) => (
              <line key={`${cellKey(a)}-${cellKey(b)}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
            ))}
          </g>

          {/* Direct: the wires. */}
          <g data-k="direct">
            <path data-k="listing" d={wire(HOST, top(GM))} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1} className="fill-none stroke-steel-edge" strokeWidth={1} />
            <line data-k="keyline" x1={RENTER.x} y1={RENTER.y} x2={HOST.x} y2={HOST.y} opacity={0} className="stroke-steel-edge" strokeWidth={1} strokeDasharray="1.5 2.5" />
            <path data-k="session" d={wire(RENTER, HOST)} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1} className="fill-none stroke-steel" strokeWidth={1.5} />
          </g>

          {/* Swarm: the wires, one per run. */}
          <g data-k="swarm" className="fill-none" strokeWidth={1}>
            {PAIRS.flat().map((h, i) => (
              <path key={i} data-k="w" d={wire(OWNER, h)} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1} className={h === LAPSED ? "stroke-steel-soft lapsed-wire" : "stroke-steel-soft"} />
            ))}
            <path data-k="tie-wire" d={wire(OWNER, TIE)} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1} className="stroke-gold" />
            <path data-k="standby-wire" d={wire(OWNER, STANDBY)} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1} className="stroke-steel-soft" />
            <path data-k="check-wire" d={wire(OWNER, top(SM))} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1} className="stroke-steel" />
          </g>

          {/* Machines. */}
          <g className="fill-dial stroke-mark-off" strokeWidth={1}>
            {LATTICE.machines.map((p) => (
              <rect key={cellKey(p)} data-k={cellKey(p) === cellKey(HOST) ? "host-base" : undefined} {...sq(p)} rx={1.25} />
            ))}
          </g>

          {/* Direct: the host, its price, the renter. */}
          <g data-k="direct-marks">
            <rect data-k="host-ring" {...sq(HOST, 13)} rx={2} opacity={0} className="fill-none stroke-steel" strokeWidth={1} />
            <rect data-k="host-lit" {...sq(HOST)} rx={1.25} opacity={0} className="fill-steel" />
            <rect data-k="host-off" {...sq(HOST, 13)} rx={2} opacity={0} className="fill-none stroke-faint" strokeWidth={1} strokeDasharray="2 2" />
            <text data-k="price" x={HOST.x + 11} y={HOST.y + 3} opacity={0} className="fill-muted font-mono" style={{ fontSize: 8.5 }}>
              0.40 ETH/h
            </text>
            <text data-k="paid" x={HOST.x + 11} y={HOST.y + 14} opacity={0} className="fill-steel font-mono" style={{ fontSize: 8 }}>
              +0.27 paid
            </text>
            <text data-k="refund" x={RENTER.x - 11} y={RENTER.y + 3} textAnchor="end" opacity={0} className="fill-steel font-mono" style={{ fontSize: 8 }}>
              +0.53 refund
            </text>
            <Renter data-k="renter" at={RENTER} />
          </g>

          {/* Swarm: the hosts at work, the tie-break, the fault, the owner and its tasks. */}
          <g data-k="swarm-marks">
            {PAIRS.flat().map((h, i) => (
              <rect key={i} data-k="lit" {...sq(h)} rx={1.25} opacity={0} className="fill-steel" />
            ))}
            <rect data-k="tie-lit" {...sq(TIE)} rx={1.25} opacity={0} className="fill-gold" />
            <rect data-k="standby-lit" {...sq(STANDBY)} rx={1.25} opacity={0} className="fill-steel" />
            <rect data-k="lapsed-off" {...sq(LAPSED, 13)} rx={2} opacity={0} className="fill-none stroke-faint" strokeWidth={1} strokeDasharray="2 2" />
            <g className="font-mono" style={{ fontSize: 8 }}>
              <text data-k="hash-a" x={PAIRS[2][0].x} y={PAIRS[2][0].y + 17} textAnchor="middle" opacity={0} className="fill-muted">
                9f2c
              </text>
              <text data-k="hash-b" x={ODD.x} y={ODD.y + 17} textAnchor="middle" opacity={0} className="fill-muted">
                41ab
              </text>
              <text data-k="hash-b-bad" x={ODD.x} y={ODD.y + 17} textAnchor="middle" opacity={0} className="fill-bad">
                41ab
              </text>
              <text data-k="hash-tie" x={TIE.x} y={TIE.y + 17} textAnchor="middle" opacity={0} className="fill-gold">
                9f2c
              </text>
            </g>
            <text data-k="fault" x={ODD.x} y={ODD.y + 27} textAnchor="middle" opacity={0} className="fill-bad" style={{ ...ENGRAVED, fontSize: 6 }}>
              FAULT
            </text>
            <g data-k="chips" opacity={0}>
              {CHIPS.map((c, i) => (
                <g key={i}>
                  <rect x={c.x - 3} y={c.y - 3} width={6} height={6} rx={1} className="fill-dial stroke-faint" strokeWidth={1} />
                  <rect data-k="chip-on" x={c.x - 3} y={c.y - 3} width={6} height={6} rx={1} opacity={0} className="fill-steel-soft" />
                  <rect data-k="chip-done" x={c.x - 3} y={c.y - 3} width={6} height={6} rx={1} opacity={0} className="fill-steel" />
                </g>
              ))}
            </g>
            <path data-k="check" d={`M${CHIPS[3].x + 9} ${OWNER.y - 1}l3 3l6 -7`} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1} className="fill-none stroke-steel" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
            <Renter data-k="owner" at={OWNER} />
          </g>

          {/* Things that travel: ETH, hashes, keys, outputs. All start hidden. */}
          <g className="fill-steel">
            {["t-list", "t-rent", "t-pulse", "t-key", "t-hostkey", "t-pay", "t-refund", "t-run", "t-run", "t-run", "t-standby-hash", "t-swarm-refund"].map((k, i) => (
              <circle key={i} data-k={k} r={k === "t-key" || k === "t-hostkey" ? 2.25 : 3} cx={-20} cy={-20} opacity={0} />
            ))}
            {PAIRS.flat().map((_, i) => (
              <circle key={i} data-k="t-hash" r={2.25} cx={-20} cy={-20} opacity={0} className="fill-dial stroke-steel" strokeWidth={1} />
            ))}
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
              <circle key={i} data-k="t-earn" r={2.5} cx={-20} cy={-20} opacity={0} />
            ))}
            {SOURCES.map((_, i) => (
              <rect key={i} data-k="t-out" x={-24} y={-24} width={5} height={5} rx={1} opacity={0} />
            ))}
          </g>
          <text data-k="key-label" x={(RENTER.x + HOST.x) / 2 + 8} y={(RENTER.y + HOST.y) / 2 + 13} opacity={0} className="fill-muted font-mono" style={{ fontSize: 8 }}>
            ssh key ⇄ host key
          </text>
        </svg>
        </figure>
      </div>
      <div aria-hidden="true" style={{ height: `${STEPS.length * SCROLL_PER_STEP}svh` }} />
    </div>
  );
}

/** A label that turns over like a date wheel when it changes. Keyed by the caller, so it replays. */
function Flip({ text, className }: { text: string; className: string }) {
  return (
    <span className={`reveal-mask ${className}`}>
      {[...text].map((ch, i) => (
        <span key={i} className="flip" style={{ ["--i" as string]: i }}>
          {ch === " " ? " " : ch}
        </span>
      ))}
    </span>
  );
}

function Renter({ at: p, ...props }: { at: Pt; "data-k": string }) {
  return (
    <g {...props} opacity={0}>
      <circle cx={p.x} cy={p.y} r={6} className="fill-dial stroke-ink" strokeWidth={1.25} />
      <circle cx={p.x} cy={p.y} r={1.75} className="fill-ink" />
    </g>
  );
}

/** A market as a sub-dial: a power-reserve arc for what it holds, the amount, and its name. */
function Dial({ at: d, name, unit, k }: { at: Pt; name: string; unit: string; k: string }) {
  return (
    <g>
      <circle cx={d.x} cy={d.y} r={DIAL} className="fill-plate stroke-line" strokeWidth={1} />
      <circle data-k={`${k}-ping`} cx={d.x} cy={d.y} r={DIAL} opacity={0} className="fill-none stroke-steel" strokeWidth={1} />
      <path d={arcPath(d)} className="fill-none stroke-line" strokeWidth={2.5} />
      <path data-k={`${k}-arc`} d={arcPath(d)} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1} className="fill-none stroke-steel" strokeWidth={2.5} />
      <g className="stroke-faint" strokeWidth={0.75}>
        {Array.from({ length: 9 }, (_, i) => {
          const deg = ARC_FROM + i * 30;
          const a = polar(d, ARC + 3, deg);
          const b = polar(d, ARC + (i % 4 === 0 ? 6.5 : 5), deg);
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
        })}
      </g>
      <text data-k={`${k}-val`} x={d.x} y={d.y + 3} textAnchor="middle" className="fill-ink font-mono tnum" style={{ fontSize: 13 }}>
        {k === "gm" ? "0.00" : "0"}
      </text>
      <text x={d.x} y={d.y + 14} textAnchor="middle" className="fill-faint" style={{ ...ENGRAVED, fontSize: 5.5 }}>
        {unit.toUpperCase()}
      </text>
      <text x={d.x} y={d.y + DIAL + 15} textAnchor="middle" className="fill-muted" style={{ ...ENGRAVED, fontSize: 7.5 }}>
        {name.toUpperCase()}
      </text>
    </g>
  );
}

/**
 * The whole story as one paused timeline: step i plays between time i and i + 1, the swarm job in
 * steps 0 to 4 and the direct rental in steps 5 to 8. Built with set/to pairs, each element's in
 * time order, so scrubbing backwards undoes each step exactly.
 *
 * At time 0 the plate is empty but for the lattice and the two dials at zero: the swarm job is about
 * to be posted. The direct marks (host ring, price, renter, wires) start hidden in the markup and
 * stay hidden until step 5.
 */
function choreograph(q: (selector: string) => Element[]) {
  const tl = gsap.timeline({ paused: true, defaults: { ease: "power2.inOut" } });
  const one = (k: string) => q(`[data-k="${k}"]`)[0];
  const all = (k: string) => q(`[data-k="${k}"]`);
  const show = (k: string | Element | Element[], t: number, d = 0.08) => tl.to(typeof k === "string" ? one(k) : k, { opacity: 1, duration: d, ease: "none" }, t);
  const hide = (k: string | Element | Element[], t: number, d = 0.08, to = 0) => tl.to(typeof k === "string" ? one(k) : k, { opacity: to, duration: d, ease: "none" }, t);
  const draw = (k: string | Element, t: number, d = 0.2) => tl.to(typeof k === "string" ? one(k) : k, { attr: { "stroke-dashoffset": 0 }, duration: d }, t);
  const undraw = (k: string | Element, t: number, d = 0.1) => tl.to(typeof k === "string" ? one(k) : k, { attr: { "stroke-dashoffset": 1 }, duration: d }, t);
  const travel = (el: Element, from: Pt, to: Pt, t: number, d = 0.2) => {
    tl.set(el, { attr: { cx: from.x, cy: from.y } }, t)
      .to(el, { opacity: 1, duration: 0.02, ease: "none" }, t)
      .to(el, { attr: { cx: to.x, cy: to.y }, duration: d }, t)
      .to(el, { opacity: 0, duration: 0.02, ease: "none" }, t + d - 0.02);
  };
  const ship = (el: Element, from: Pt, to: Pt, t: number, d = 0.24) => {
    tl.set(el, { attr: { x: from.x - 2.5, y: from.y - 2.5 } }, t)
      .to(el, { opacity: 1, duration: 0.02, ease: "none" }, t)
      .to(el, { attr: { x: to.x - 2.5, y: to.y - 2.5 }, duration: d }, t)
      .to(el, { opacity: 0, duration: 0.02, ease: "none" }, t + d - 0.02);
  };
  const ping = (k: "gm" | "sm", t: number) =>
    tl.fromTo(one(`${k}-ping`), { attr: { r: DIAL }, opacity: 0.9 }, { attr: { r: DIAL + 7 }, opacity: 0, duration: 0.14, ease: "power2.out", immediateRender: false }, t);
  // A dial's reading: the arc and the number move together.
  const reading = { gm: { v: 0 }, sm: { v: 0 } };
  const dial = (k: "gm" | "sm", value: number, full: number, t: number, d = 0.12) => {
    tl.to(one(`${k}-arc`), { attr: { "stroke-dashoffset": 1 - value / full }, duration: d }, t);
    const text = one(`${k}-val`);
    tl.to(reading[k], { v: value, duration: d, onUpdate: () => (text.textContent = k === "gm" ? reading.gm.v.toFixed(2) : String(Math.round(reading.sm.v))) }, t);
  };

  // Blocks keep arriving all the way through.
  tl.to(one("blocks"), { x: -8 * 4 * STEPS.length, duration: STEPS.length, ease: "none" }, 0);

  // 0 · postJob: an owner posts four tasks and pays for three runs of each into SwarmMarket.
  tl.fromTo(one("owner"), { opacity: 0, scale: 0.4, transformOrigin: "50% 50%" }, { opacity: 1, scale: 1, duration: 0.1, ease: "back.out(2)", immediateRender: false }, 0.04);
  tl.fromTo(one("chips"), { opacity: 0 }, { opacity: 1, duration: 0.1, ease: "none", immediateRender: false }, 0.1);
  all("t-run").forEach((el, i) => travel(el, OWNER, top(SM), 0.22 + i * 0.09, 0.2));
  dial("sm", 12, 12, 0.42, 0.22);
  ping("sm", 0.62);

  // 1 · claim and submit: idle hosts across the network take the runs; each sends a sealed hash.
  const flat = PAIRS.flat();
  all("w").forEach((el, i) => draw(el, 1 + i * 0.035, 0.18));
  all("lit").forEach((el, i) => show(el, 1.16 + i * 0.035, 0.04));
  all("chip-on").forEach((el, i) => show(el, 1.1 + i * 0.07, 0.04));
  all("t-hash").forEach((el, i) => travel(el, flat[i], top(SM), 1.46 + i * 0.035, 0.2));
  ping("sm", 1.9);

  // 2 · reveal: matching pairs are paid; the third pair disagrees, a tie-break host settles it and
  // the odd one out is recorded as a fault.
  const earn = all("t-earn");
  [PAIRS[0][0], PAIRS[0][1], PAIRS[1][0], PAIRS[1][1]].forEach((h, i) => travel(earn[i], top(SM), h, 2.02 + i * 0.03, 0.18));
  dial("sm", 8, 12, 2.04);
  show("hash-a", 2.26, 0.05);
  show("hash-b", 2.3, 0.05);
  draw("tie-wire", 2.38, 0.12);
  show("tie-lit", 2.5, 0.04);
  show("hash-tie", 2.54, 0.05);
  show("hash-b-bad", 2.62, 0.05);
  show("fault", 2.64, 0.05);
  hide(all("lit")[flat.indexOf(ODD)], 2.64, 0.05);
  [PAIRS[2][0], TIE].forEach((h, i) => travel(earn[4 + i], top(SM), h, 2.7 + i * 0.03, 0.16));
  dial("sm", 6, 12, 2.72);

  // 3 · a lease runs out and is handed on; the job is closed and the runs not needed go back.
  hide(all("lit")[flat.indexOf(LAPSED)], 3, 0.04);
  show("lapsed-off", 3.02, 0.06);
  hide(q(".lapsed-wire"), 3.02, 0.08, 0.15);
  draw("standby-wire", 3.12, 0.14);
  show("standby-lit", 3.26, 0.04);
  travel(one("t-standby-hash"), STANDBY, top(SM), 3.3, 0.14);
  [PAIRS[3][0], STANDBY].forEach((h, i) => travel(earn[6 + i], top(SM), h, 3.46 + i * 0.03, 0.14));
  dial("sm", 4, 12, 3.48);
  travel(one("t-swarm-refund"), top(SM), OWNER, 3.66, 0.18);
  dial("sm", 0, 12, 3.68);

  // 4 · results: outputs come straight from the hosts, are checked against the hashes on-chain,
  // and the tasks are done.
  hide(q('[data-k="w"], [data-k="tie-wire"], [data-k="standby-wire"]'), 4, 0.1, 0.25);
  all("t-out").forEach((el, i) => ship(el, SOURCES[i], OWNER, 4.06 + i * 0.05, 0.26));
  draw("check-wire", 4.38, 0.14);
  all("chip-done").forEach((el, i) => show(el, 4.52 + i * 0.04, 0.04));
  draw("check", 4.62, 0.1);

  // 5 · listMachine: the finished swarm job steps back; a host's node lists its machine and the
  // listing lands in GridMarket.
  hide(q('[data-k="swarm"], [data-k="swarm-marks"]'), 5, 0.08, 0.28);
  show("host-ring", 5, 0.12);
  tl.fromTo(one("price"), { opacity: 0, y: 3 }, { opacity: 1, y: 0, duration: 0.16, ease: "power2.out", immediateRender: false }, 5.06);
  draw("listing", 5.18, 0.32);
  travel(one("t-list"), HOST, top(GM), 5.4, 0.3);
  ping("gm", 5.7);

  // 6 · rent: the renter pays into the dial, the node sees it and starts the container, keys are
  // exchanged, and the session runs.
  tl.fromTo(one("renter"), { opacity: 0, scale: 0.4, transformOrigin: "50% 50%" }, { opacity: 1, scale: 1, duration: 0.1, ease: "back.out(2)", immediateRender: false }, 6);
  travel(one("t-rent"), RENTER, top(GM), 6.08, 0.22);
  ping("gm", 6.3);
  dial("gm", 0.8, 0.8, 6.3);
  travel(one("t-pulse"), top(GM), HOST, 6.42, 0.16);
  show("host-lit", 6.56, 0.05);
  show("keyline", 6.6, 0.04);
  show("key-label", 6.6, 0.05);
  travel(one("t-key"), RENTER, HOST, 6.62, 0.1);
  travel(one("t-hostkey"), HOST, RENTER, 6.73, 0.1);
  hide("key-label", 6.84, 0.04);
  hide("keyline", 6.84, 0.04);
  draw("session", 6.82, 0.08);

  // 7 · endRental: time passes, the session ends, the host is paid for the minutes started and
  // the rest goes back to the renter.
  hide("session", 7.3, 0.06);
  hide("host-lit", 7.3, 0.06);
  travel(one("t-pay"), top(GM), HOST, 7.38, 0.2);
  dial("gm", 0.53, 0.8, 7.4);
  show("paid", 7.56, 0.06);
  travel(one("t-refund"), top(GM), RENTER, 7.6, 0.2);
  dial("gm", 0, 0.8, 7.62);
  show("refund", 7.78, 0.06);

  // 8 · the host goes offline: the machine drops out of the network.
  hide("paid", 8, 0.05);
  hide("refund", 8, 0.05);
  tl.set(one("session"), { attr: { "stroke-dashoffset": 1 }, opacity: 1 }, 8.04);
  draw("session", 8.06, 0.08);
  show("host-lit", 8.06, 0.04);
  hide("host-lit", 8.36, 0.03);
  hide("session", 8.36, 0.06);
  hide("host-ring", 8.36, 0.04);
  show("host-off", 8.38, 0.06);
  hide("host-base", 8.38, 0.06, 0.25);
  hide("price", 8.4, 0.08, 0.35);
  hide("listing", 8.4, 0.08, 0.3);
  hide("renter", 8.5, 0.1, 0.4);

  tl.set({}, {}, STEPS.length);
  return tl;
}
