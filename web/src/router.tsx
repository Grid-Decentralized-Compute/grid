import { type AnchorHTMLAttributes, useEffect, useState } from "react";

// A few pages need no router library: pushState plus a listener set.
const listeners = new Set<() => void>();

/** Scrolls to the element named by the URL hash, or to the top when there is none. */
export function scrollToHash() {
  let id = "";
  try {
    id = decodeURIComponent(window.location.hash.slice(1));
  } catch {
    // a malformed #fragment: just scroll to the top
  }
  // Wait a frame so the page that owns the anchor has rendered.
  requestAnimationFrame(() => {
    const el = id ? document.getElementById(id) : null;
    if (el) el.scrollIntoView();
    else window.scrollTo(0, 0);
  });
}

export function navigate(to: string, { scroll = true }: { scroll?: boolean } = {}) {
  if (to === window.location.pathname + window.location.hash) return;
  window.history.pushState(null, "", to);
  listeners.forEach((l) => l());
  if (scroll) scrollToHash();
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
