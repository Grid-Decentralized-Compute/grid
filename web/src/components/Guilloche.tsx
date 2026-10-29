import { useEffect, useRef, useState } from "react";
import { reducedMotion } from "../lib/motion";

/** The sunburst dial behind the network plate (lib/guilloche.ts). It fades in once Three.js has loaded. */
export function Guilloche({ className = "" }: { className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [on, setOn] = useState(false);

  useEffect(() => {
    let dial: { stop(): void } | null = null;
    let cancelled = false;
    void import("../lib/guilloche").then(({ mountGuilloche }) => {
      if (cancelled || !canvas.current) return;
      dial = mountGuilloche(canvas.current, { still: reducedMotion() });
      if (dial) setOn(true);
    });
    return () => {
      cancelled = true;
      dial?.stop();
    };
  }, []);

  return (
    <canvas
      ref={canvas}
      aria-hidden="true"
      className={`pointer-events-none transition-opacity duration-[1400ms] ease-out ${on ? "opacity-100" : "opacity-0"} ${className}`}
    />
  );
}
