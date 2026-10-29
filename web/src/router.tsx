import { type AnchorHTMLAttributes, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { reducedMotion, scrollToTarget } from "./lib/motion";

// A few pages need no router library: pushState plus a listener set.
const listeners = new Set<() => void>();

/** Jumps to the element named by the URL hash, or to the top when there is none. Call once the page has rendered. */
export function scrollToHash() {
  let id = "";
  try {
    id = decodeURIComponent(window.location.hash.slice(1));
  } catch {
    // a malformed #fragment: just go to the top
  }
  scrollToTarget((id && document.getElementById(id)) || 0);
}

/**
 * Goes to another page. The new page is rendered synchronously inside a view transition, so the
 * browser can cross-fade from the old page to the new one and glide the navigation index between
 * tabs (index.css). Links that switch a view in place (`scroll: false`) change without one.
 */
export function navigate(to: string, { scroll = true }: { scroll?: boolean } = {}) {
  if (to === window.location.pathname + window.location.hash) return;
  const update = () => {
    window.history.pushState(null, "", to);
    flushSync(() => listeners.forEach((l) => l()));
    if (scroll) scrollToHash();
  };
  // Only from near the top, where the header is in view: from deep in a page the header would fly in.
  const nearTop = window.scrollY < window.innerHeight / 4;
  if (scroll && nearTop && "startViewTransition" in document && !reducedMotion()) document.startViewTransition(update);
  else update();
}

export function usePath(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return path;
}

/** An in-app link: plain <a> semantics, client-side navigation on a normal click. */
/** `scroll={false}` keeps the page where it is, for links that switch a view in place. */
export function Link({
  href,
  onClick,
  scroll = true,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; scroll?: boolean }) {
  return (
    <a
      href={href}
      {...props}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(href, { scroll });
      }}
    />
  );
}
