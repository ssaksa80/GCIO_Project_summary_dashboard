/**
 * Motion layer (GSAP).
 *
 * Everything here degrades to "no animation, correct final state" when the
 * viewer prefers reduced motion — an executive screen must never withhold a
 * number because a tween did not run.
 */
import { useEffect, useRef, useState } from "react";
import gsap from "gsap";

export const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Reveal a container's [data-reveal] children on first scroll into view:
 * a short rise + fade with a stagger, then the elements are left alone.
 * @param {Array} deps re-run when the underlying data changes
 * @returns {import('react').RefObject<HTMLElement>}
 */
export function useReveal(deps = []) {
  const ref = useRef(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    const targets = root.querySelectorAll("[data-reveal]");
    if (!targets.length) return undefined;

    if (reducedMotion()) {
      gsap.set(targets, { opacity: 1, y: 0, clearProps: "all" });
      return undefined;
    }

    let tween = null;
    gsap.set(targets, { opacity: 0, y: 14 });

    const io = new IntersectionObserver((entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        obs.disconnect();
        tween = gsap.to(targets, {
          opacity: 1,
          y: 0,
          duration: 0.5,
          ease: "power2.out",
          stagger: 0.045,
          clearProps: "transform",
        });
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });

    io.observe(root);
    return () => {
      io.disconnect();
      if (tween) tween.kill();
      gsap.set(targets, { opacity: 1, y: 0 });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}

/**
 * Count a number up when it enters view, and re-count whenever it changes so a
 * live ingest visibly moves the KPI rather than silently swapping it.
 */
export function CountUp({ value, format = (n) => Math.round(n).toLocaleString("en-AE"), duration = 0.9, className }) {
  const ref = useRef(null);
  const from = useRef(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const target = Number(value) || 0;

    if (reducedMotion()) {
      node.textContent = format(target);
      from.current = target;
      return undefined;
    }

    const state = { n: from.current };
    const tween = gsap.to(state, {
      n: target,
      duration,
      ease: "power2.out",
      onUpdate: () => { node.textContent = format(state.n); },
      onComplete: () => { from.current = target; },
    });
    return () => {
      tween.kill();
      from.current = target;
      if (node) node.textContent = format(target);
    };
  }, [value, duration, format]);

  return <span ref={ref} className={className}>{format(Number(value) || 0)}</span>;
}

/**
 * Grow a bar/track from zero to its width once, on view.
 * @param {number} pct 0–100
 */
export function useGrow(pct) {
  const ref = useRef(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const width = `${Math.max(0, Math.min(100, Number(pct) || 0))}%`;
    if (reducedMotion()) {
      node.style.width = width;
      return undefined;
    }
    const tween = gsap.fromTo(node, { width: "0%" }, { width, duration: 0.85, ease: "power2.out", delay: 0.08 });
    return () => { tween.kill(); node.style.width = width; };
  }, [pct]);
  return ref;
}

/** Pulse an element whenever `signal` changes — used for the live ingest ping. */
export function usePulse(signal) {
  const ref = useRef(null);
  const first = useRef(true);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    if (first.current) { first.current = false; return undefined; }
    if (reducedMotion()) return undefined;
    const tween = gsap.fromTo(node,
      { boxShadow: "0 0 0 0 var(--glow-accent)" },
      { boxShadow: "0 0 0 14px transparent", duration: 1.1, ease: "power2.out" });
    return () => tween.kill();
  }, [signal]);
  return ref;
}

/** Which section is currently in view — drives the section nav's active pill. */
export function useScrollSpy(ids, offset = 150) {
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    const sections = ids.map((id) => document.getElementById(id)).filter(Boolean);
    if (!sections.length) return undefined;
    const onScroll = () => {
      let current = ids[0];
      for (const section of sections) {
        if (section.getBoundingClientRect().top - offset <= 0) current = section.id;
      }
      setActive(current);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [ids, offset]);
  return active;
}

/** Smooth-scroll to a section, accounting for the sticky header stack. */
export function scrollToSection(id, offset = 128) {
  const node = document.getElementById(id);
  if (!node) return;
  const top = node.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top, behavior: reducedMotion() ? "auto" : "smooth" });
}
