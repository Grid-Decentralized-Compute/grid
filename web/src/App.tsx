import { Component, type ReactNode, useEffect } from "react";
import { Wallet } from "./components/Wallet";
import { About } from "./pages/About";
import { Host } from "./pages/Host";
import { Market } from "./pages/Market";
import { Rentals } from "./pages/Rentals";
import { Link, usePath } from "./router";
import { SOURCE_URL } from "./lib/links";

const pages: Record<string, { label: string; title: string; render: () => ReactNode }> = {
  "/": { label: "Market", title: "Grid", render: () => <Market /> },
  "/rentals": { label: "Rentals", title: "Rentals · Grid", render: () => <Rentals /> },
  "/host": { label: "Host", title: "Host · Grid", render: () => <Host /> },
  "/about": { label: "About", title: "About · Grid", render: () => <About /> },
};

export default function App() {
  const path = usePath();
  const page = pages[path.replace(/\/+$/, "") || "/"];

  useEffect(() => {
    document.title = page?.title ?? "Not found · Grid";
  }, [page]);

  return (
    <div className="mx-auto flex min-h-screen max-w-[1040px] flex-col px-5 sm:px-8">
      <header className="flex flex-wrap items-center gap-x-10 gap-y-4 py-5">
        <Link href="/" className="flex items-center gap-2.5 text-[15px] font-semibold tracking-[-0.01em]">
          <Mark />
          grid
        </Link>
        <nav aria-label="Pages" className="order-last flex w-full gap-6 text-[13px] sm:order-none sm:w-auto">
          {Object.entries(pages).map(([href, p]) => (
            <Link
              key={href}
              href={href}
              aria-current={page === p ? "page" : undefined}
              className={page === p ? "text-ink" : "text-muted transition-colors hover:text-ink"}
            >
              {p.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto">
          <Wallet />
        </div>
      </header>

      <main className="flex-1 pb-28 pt-12 sm:pt-20">
        <ErrorBoundary key={path}>
          {page ? (
            page.render()
          ) : (
            <p className="text-muted">
              There is no page at {path}.{" "}
              <Link href="/" className="text-ink underline underline-offset-[3px]">
                Go to the market
              </Link>
            </p>
          )}
        </ErrorBoundary>
      </main>

      <footer className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line py-6 text-[12px] text-faint">
        <span>A peer-to-peer market for compute on Robinhood Chain.</span>
        <a href={SOURCE_URL} className="transition-colors hover:text-ink sm:ml-auto">
          Source
        </a>
      </footer>
    </div>
  );
}

function Mark() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
      {[0, 6, 12].flatMap((y) =>
        [0, 6, 12].map((x) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="4" height="4" rx="1" fill="currentColor" opacity={x === 6 && y === 6 ? 0.3 : 1} />
        )),
      )}
    </svg>
  );
}

/** Keeps one bad listing or a surprising wallet error from blanking the whole page. */
class ErrorBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state = { message: null as string | null };

  static getDerivedStateFromError(e: unknown) {
    return { message: e instanceof Error ? e.message : String(e) };
  }

  render() {
    if (this.state.message) return <p className="text-[13px] text-bad">This page could not be shown: {this.state.message}</p>;
    return this.props.children;
  }
}
