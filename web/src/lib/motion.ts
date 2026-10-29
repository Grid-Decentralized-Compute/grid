import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import Lenis from "lenis";

gsap.registerPlugin(ScrollTrigger, SplitText);

const reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
/** Read live: a visitor can turn reduced motion on while the page is open. */
export const reducedMotion = () => reduceQuery.matches;

let lenis: Lenis | null = null;

/**
 * Smooth scrolling for wheels and trackpads; touch keeps the phone's own scrolling. GSAP's ticker
 * drives Lenis, so scroll-linked drawings and the scroll position move on the same frame. Lenis
 * itself turns smoothing off for reduced motion, and lets scrollable boxes (job outputs) scroll.
 */
export function startSmoothScroll() {
  if (lenis) return;
  lenis = new Lenis({ autoRaf: false, lerp: 0.11, allowNestedScroll: true, stopInertiaOnNavigate: true });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((time) => lenis?.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
}

/** Moves the page to an element or a y position: at once, or gliding when `smooth`. */
export function scrollToTarget(target: HTMLElement | number, smooth = false) {
  if (lenis) {
    lenis.scrollTo(target, { immediate: !smooth, force: true });
    return;
  }
  const behavior = smooth ? "smooth" : "instant";
  if (typeof target === "number") window.scrollTo({ top: target, behavior });
  else target.scrollIntoView({ behavior });
}

export { gsap, ScrollTrigger, SplitText };
