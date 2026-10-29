import { useEffect, useState } from "react";

type Theme = "light" | "dark";

const current = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

function apply(theme: Theme) {
  const root = document.documentElement;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduced) {
    root.classList.add("theme-fade");
    window.setTimeout(() => root.classList.remove("theme-fade"), 320);
  }
  root.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#121316" : "#f3f3f0");
}

/** Day / night switch. Follows the system until the visitor picks one, then remembers it. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(current);

  // Keep following the system while the visitor has not chosen.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem("grid-theme");
      } catch {
        // storage unavailable: just follow the system
      }
      if (saved) return;
      const next: Theme = media.matches ? "dark" : "light";
      apply(next);
      setTheme(next);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const next: Theme = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={() => {
        apply(next);
        try {
          localStorage.setItem("grid-theme", next);
        } catch {
          // storage unavailable: the choice lasts for this page view
        }
        setTheme(next);
      }}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className="text-muted transition-colors hover:text-steel"
    >
      {theme === "dark" ? (
        <svg viewBox="0 0 24 24" className="size-[16px]" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path
            strokeLinecap="round"
            d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="size-[15px]" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path strokeLinejoin="round" d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
        </svg>
      )}
    </button>
  );
}
