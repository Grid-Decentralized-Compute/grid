import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "danger";

const buttonStyles: Record<Variant, string> = {
  primary: "bg-emerald-500 text-zinc-950 hover:bg-emerald-400",
  secondary: "bg-zinc-800 text-zinc-100 hover:bg-zinc-700",
  danger: "bg-red-500/90 text-white hover:bg-red-500",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${buttonStyles[variant]} ${className}`}
    />
  );
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm outline-none focus:border-emerald-500 ${className}`}
    />
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-zinc-800 bg-zinc-900 p-4 ${className}`}>{children}</div>;
}

const badgeStyles = {
  neutral: "bg-zinc-800 text-zinc-300",
  good: "bg-emerald-500/15 text-emerald-300",
  warn: "bg-amber-500/15 text-amber-300",
  bad: "bg-red-500/15 text-red-300",
};

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: keyof typeof badgeStyles }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badgeStyles[tone]}`}>{children}</span>;
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-base font-medium">{value}</div>
    </div>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? <p className="break-words text-sm text-red-400">{children}</p> : null;
}

export function Muted({ children }: { children: ReactNode }) {
  return <p className="text-sm text-zinc-400">{children}</p>;
}
