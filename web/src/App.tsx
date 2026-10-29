import { Component, type ReactNode, useEffect } from "react";
import { Caseback } from "./components/Caseback";
import { GitHubIcon, XIcon } from "./components/Icons";
import { Wallet } from "./components/Wallet";
import { SOURCE_URL, X_URL } from "./lib/links";
import { About } from "./pages/About";
import { Host } from "./pages/Host";
import { Legal } from "./pages/Legal";
import { Market } from "./pages/Market";
import { Rentals } from "./pages/Rentals";
import { Link, scrollToHash, usePath } from "./router";

type PageDef = { label: string; title: string; nav: boolean; render: () => ReactNode };

const pages: Record<string, PageDef> = {
  "/": { label: "Market", title: "Grid", nav: true, render: () => <Market /> },
  "/rentals": { label: "Rentals", title: "Rentals · Grid", nav: true, render: () => <Rentals /> },
  "/host": { label: "Host", title: "Host · Grid", nav: true, render: () => <Host /> },
  "/about": { label: "About", title: "About · Grid", nav: true, render: () => <About /> },
  "/legal": { label: "Legal", title: "Legal · Grid", nav: false, render: () => <Legal /> },
};

export default function App() {
  const path = usePath();
  const page = pages[path.replace(/\/+$/, "") || "/"];

  useEffect(() => {
    document.title = page?.title ?? "Not found · Grid";
  }, [page]);

  // A link that arrives with #section (e.g. /legal#privacy) opens at that section.
  useEffect(() => {
    if (window.location.hash) scrollToHash();
  }, []);

  return (
    <div className="mx-auto flex min-h-screen max-w-[1040px] flex-col px-5 sm:px-8">
      <header className="flex flex-wrap items-center gap-x-10 gap-y-4 py-5">
        <Link href="/" className="flex items-center gap-2.5 font-serif text-[21px] font-normal leading-none tracking-[-0.01em]">
          <Mark />
          Grid
        </Link>
        <nav aria-label="Pages" className="order-last flex w-full gap-6 text-[13px] sm:order-none sm:w-auto">
          {Object.entries(pages)
            .filter(([, p]) => p.nav)
            .map(([href, p]) => (
            <Link
              key={href}
              href={href}
              aria-current={page === p ? "page" : undefined}
              className={
                page === p
                  ? "text-ink underline decoration-steel decoration-[1.5px] underline-offset-[6px]"
                  : "text-muted transition-colors hover:text-ink"
              }
            >
              {p.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-5">
          <a href={X_URL} aria-label="Grid on X" className="text-muted transition-colors hover:text-steel">
            <XIcon className="size-[15px]" />
          </a>
          <a href={SOURCE_URL} aria-label="Source on GitHub" className="text-muted transition-colors hover:text-steel">
            <GitHubIcon className="size-[16px]" />
          </a>
          <span className="h-4 w-px bg-line" aria-hidden="true" />
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

      <Caseback />
    </div>
  );
}

function Mark() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
      {[0, 6, 12].flatMap((y) =>
        [0, 6, 12].map((x) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="4" height="4" rx="1" fill={x === 6 && y === 6 ? "#1f3c78" : "currentColor"} />
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
