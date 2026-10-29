import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "quiet" | "danger";

const variants: Record<Variant, string> = {
  primary: "h-8 px-3 bg-ink text-white hover:bg-neutral-700",
  secondary: "h-8 px-3 border border-line bg-white text-ink hover:border-neutral-400",
  quiet: "h-auto px-0 text-muted hover:text-ink",
  danger: "h-8 px-3 border border-line bg-white text-bad hover:border-bad/40",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 ${variants[variant]} ${className}`}
    />
  );
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`tnum h-8 rounded-md border border-line bg-white px-2.5 font-mono text-[13px] outline-none transition-colors focus:border-ink ${className}`}
    />
  );
}

const tones = { ok: "bg-ok", busy: "bg-busy", off: "bg-neutral-300", bad: "bg-bad" };
export type Tone = keyof typeof tones;

export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-[13px] text-muted">
      <span className={`size-1.5 shrink-0 rounded-full ${tones[tone]}`} aria-hidden="true" />
      {children}
    </span>
  );
}

/** A page: a small title, an optional one-line lede, then content. */
export function Page({ title, lede, children }: { title: string; lede?: ReactNode; children: ReactNode }) {
  return (
    <>
      <h1 className="text-[22px] font-medium tracking-[-0.015em]">{title}</h1>
      {lede && <p className="mt-2 max-w-[58ch] text-muted">{lede}</p>}
      <div className="mt-12">{children}</div>
    </>
  );
}

/** A titled block within a page, ruled underneath its title. */
export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-14 first:mt-0">
      <div className="flex min-h-8 items-center justify-between gap-4 border-b border-line pb-2">
        <h2 className="text-[13px] font-medium">{title}</h2>
        {aside}
      </div>
      <div className="pt-5">{children}</div>
    </section>
  );
}

export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-faint">{label}</dt>
      <dd className="tnum mt-0.5 truncate font-mono text-[14px]">{children}</dd>
    </div>
  );
}

export function ErrorText({ children, className = "" }: { children: ReactNode; className?: string }) {
  return children ? <p className={`break-words text-[13px] text-bad ${className}`}>{children}</p> : null;
}

export function Note({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-[14px] text-muted ${className}`}>{children}</p>;
}

export const linkClass = "text-ink underline decoration-neutral-300 underline-offset-[3px] hover:decoration-ink";
