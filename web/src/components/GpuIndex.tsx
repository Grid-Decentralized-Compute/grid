import { fmtEth } from "../lib/format";
import { type Filters, filtersActive, type GpuGroup, VRAM_STEPS } from "../lib/machines";

/** At most this many index marks per tile; beyond it the marks show the share that is free. */
const MAX_MARKS = 16;

/**
 * The market at a glance, one tile per GPU model: how many machines carry it, how many are free
 * right now, and the cheapest free GPU-hour. A tile is also the GPU filter. Below it, the other
 * filters; all of them live in the query string.
 */
export function GpuIndex({
  groups,
  filters,
  onChange,
  onClear,
}: {
  groups: GpuGroup[];
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
  onClear: () => void;
}) {
  const machines = groups.reduce((n, g) => n + g.total, 0);
  const free = groups.reduce((n, g) => n + g.free, 0);

  return (
    <section className="mt-12" aria-label="GPUs">
      <div className="flex items-end justify-between gap-4 border-b border-rule pb-2">
        <h2 className="engraved text-ink">
          GPUs<span className="tnum ml-2 text-faint">{String(groups.length).padStart(2, "0")}</span>
        </h2>
        <span className="engraved tnum text-faint">
          <span className={free > 0 ? "text-steel" : undefined}>{free}</span> of {machines} machines free
        </span>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {groups.map((g, i) => (
          <GpuTile
            key={g.key}
            group={g}
            index={i}
            selected={filters.gpu === g.key}
            onSelect={() => onChange({ gpu: filters.gpu === g.key ? null : g.key })}
          />
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-4 text-[13px]">
        <button
          type="button"
          role="switch"
          aria-checked={filters.free}
          onClick={() => onChange({ free: !filters.free })}
          className="group inline-flex items-center gap-2.5"
        >
          <span
            aria-hidden="true"
            className={`relative h-[14px] w-[26px] rounded-full border transition-colors duration-300 ${filters.free ? "border-steel bg-steel" : "border-line bg-plate group-hover:border-steel-edge"}`}
          >
            <span
              className={`absolute top-[2px] size-[8px] rounded-full transition-[left,background-color] duration-300 ease-[cubic-bezier(0.2,0.7,0.2,1)] ${filters.free ? "left-[14px] bg-on-steel" : "left-[2px] bg-faint"}`}
            />
          </span>
          <span className={`engraved transition-colors ${filters.free ? "text-steel" : "text-muted group-hover:text-ink"}`}>
            Free now
          </span>
        </button>

        <Choice
          label="VRAM"
          options={VRAM_STEPS.map((gb) => ({ value: gb, text: gb === 0 ? "Any" : `${gb}+` }))}
          value={filters.vram}
          suffix="GB"
          onPick={(vram) => onChange({ vram })}
        />

        <Choice
          label="Sort"
          options={[
            { value: "price" as const, text: "Price" },
            { value: "vram" as const, text: "VRAM" },
          ]}
          value={filters.sort}
          onPick={(sort) => onChange({ sort })}
        />

        <span className="engraved text-faint sm:ml-auto">Prices in ETH per GPU-hour</span>
        {filtersActive(filters) && (
          <button type="button" onClick={onClear} className="ink-link text-steel">
            Clear filters
          </button>
        )}
      </div>
    </section>
  );
}

function GpuTile({ group: g, index, selected, onSelect }: { group: GpuGroup; index: number; selected: boolean; onSelect: () => void }) {
  const marks = Math.min(g.total, MAX_MARKS);
  const lit = g.free === 0 ? 0 : Math.max(1, Math.round((g.free / g.total) * marks));
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      title={selected ? "Show every GPU" : `Show only ${g.model}`}
      className={`rise group relative overflow-hidden rounded-[3px] border px-4 pb-3.5 pt-3.5 text-left transition-[border-color,background-color] duration-300 ${
        selected ? "border-steel bg-steel-faint" : "border-line hover:border-steel-edge"
      } ${g.free === 0 ? "opacity-70 hover:opacity-100" : ""}`}
      style={{ animationDelay: `${index * 45}ms` }}
    >
      {/* The chosen tile carries a steel rule along its top. */}
      <span
        aria-hidden="true"
        className={`absolute inset-x-0 top-0 h-0.5 origin-left bg-steel transition-transform duration-500 ease-[cubic-bezier(0.2,0.7,0.2,1)] ${selected ? "scale-x-100" : "scale-x-0"}`}
      />
      <span className="flex items-baseline justify-between gap-3">
        <span className={`truncate text-[15px] font-medium transition-colors ${selected ? "text-steel" : "group-hover:text-steel"}`}>{g.model}</span>
        {g.vramGb > 0 && <span className="tnum shrink-0 font-mono text-[12px] text-faint">{g.vramGb} GB</span>}
      </span>

      {/* A gauge across the tile, one segment per machine (or per share of them): steel for free. */}
      <span className="mt-4 flex h-[5px] items-end gap-[3px]" aria-hidden="true">
        {Array.from({ length: marks }, (_, i) => (
          <span
            key={i}
            className={`seg h-[3px] flex-1 rounded-[1px] transition-[height,background-color] duration-300 ${i < lit ? "bg-steel group-hover:h-[5px]" : "bg-line"}`}
            style={{ animationDelay: `${index * 45 + 120 + i * 30}ms` }}
          />
        ))}
      </span>

      <span className="mt-2.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="tnum whitespace-nowrap text-[12.5px] text-muted">
          {g.free} of {g.total} free
        </span>
        <span className="tnum whitespace-nowrap font-mono text-[13px]">
          <span className="engraved mr-1.5 text-faint">From</span>
          {fmtEth(g.from, 6)}
        </span>
      </span>
    </button>
  );
}

/** An engraved label and a row of options; the chosen one carries the steel rule. */
function Choice<T extends string | number>({
  label,
  options,
  value,
  suffix,
  onPick,
}: {
  label: string;
  options: { value: T; text: string }[];
  value: T;
  suffix?: string;
  onPick: (v: T) => void;
}) {
  return (
    <span role="group" aria-label={label} className="inline-flex items-baseline gap-3">
      <span className="engraved text-faint">{label}</span>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onPick(o.value)}
          className={`nav-link tnum transition-colors ${o.value === value ? "text-ink" : "text-muted hover:text-ink"}`}
        >
          {o.text}
        </button>
      ))}
      {suffix && <span className="engraved text-faint">{suffix}</span>}
    </span>
  );
}
