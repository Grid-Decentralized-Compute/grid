import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "quiet" | "danger";

const variants: Record<Variant, string> = {
  primary: "h-8 px-3.5 bg-steel text-on-steel hover:bg-steel-deep",
  secondary: "h-8 px-3.5 border border-line bg-transparent text-ink hover:border-steel hover:text-steel",
  quiet: "h-auto px-0 text-muted hover:text-steel",
  danger: "h-8 px-3.5 border border-line bg-transparent text-bad hover:border-bad",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-[3px] text-[13px] font-medium tracking-[0.01em] transition-colors disabled:pointer-events-none disabled:opacity-40 ${variants[variant]} ${className}`}
    />
  );
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`tnum h-8 rounded-[3px] border border-line bg-dial px-2.5 font-mono text-[13px] outline-none transition-colors focus:border-steel ${className}`}
    />
  );
}

const tones = { ok: "bg-ok", busy: "bg-busy", off: "bg-mark-off", bad: "bg-bad" };
export type Tone = keyof typeof tones;

/** A status reading: a small applied index and its label. */
export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-[13px] text-muted">
      <span className={`h-[7px] w-[2px] shrink-0 ${tones[tone]}`} aria-hidden="true" />
      {children}
    </span>
  );
}

/** Engraved label, used for every caption and column head. */
export function Label({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`engraved text-faint ${className}`}>{children}</span>;
}

/** A page: a serif title, an optional lede, then content. */
export function Page({ title, lede, children }: { title: string; lede?: ReactNode; children: ReactNode }) {
  return (
    <>
      <h1 className="font-serif text-[34px] font-light leading-[1.1] tracking-[-0.01em]">{title}</h1>
      {lede && <p className="mt-3 max-w-[60ch] text-muted">{lede}</p>}
      <div className="mt-14">{children}</div>
    </>
  );
}

/** A titled block within a page, ruled underneath its title. */
export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-16 first:mt-0">
      <div className="flex min-h-8 items-end justify-between gap-4 border-b border-rule pb-2">
        <h2 className="engraved text-ink">{title}</h2>
        {aside}
      </div>
      <div className="pt-5">{children}</div>
    </section>
  );
}

export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="engraved text-faint">{label}</dt>
      <dd className="tnum mt-1 truncate font-mono text-[14px]">{children}</dd>
    </div>
  );
}

export function ErrorText({ children, className = "" }: { children: ReactNode; className?: string }) {
  return children ? <p className={`break-words text-[13px] text-bad ${className}`}>{children}</p> : null;
}

export function Note({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-[14px] text-muted ${className}`}>{children}</p>;
}

export const linkClass =
  "ink-link text-steel";
