import { type AnchorHTMLAttributes, useEffect, useState } from "react";

// A few pages need no router library: pushState plus a listener set.
const listeners = new Set<() => void>();

/** Scrolls to the element named by the URL hash, or to the top when there is none. */
export function scrollToHash() {
  const id = decodeURIComponent(window.location.hash.slice(1));
  // Wait a frame so the page that owns the anchor has rendered.
  requestAnimationFrame(() => {
    const el = id ? document.getElementById(id) : null;
    if (el) el.scrollIntoView();
    else window.scrollTo(0, 0);
  });
}

export function navigate(to: string) {
  if (to === window.location.pathname + window.location.hash) return;
  window.history.pushState(null, "", to);
  listeners.forEach((l) => l());
  scrollToHash();
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
export function Link({ href, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      href={href}
      {...props}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(href);
      }}
    />
  );
}
