"use client";

import { useEffect, useRef } from "react";

const revealMarker = "[data-reveal]";
const revealedClass = "motion-revealed";

function observeReveals() {
  if (typeof IntersectionObserver === "undefined") return;

  const visibility = new IntersectionObserver((entries) => {
    for (const { isIntersecting, target } of entries) {
      if (!isIntersecting) continue;
      visibility.unobserve(target);
      if (target.isConnected && target.matches(revealMarker)) target.classList.add(revealedClass);
    }
  });

  function updateTarget(element: Element) {
    if (element.isConnected && element.matches(revealMarker) && !element.classList.contains(revealedClass)) {
      visibility.observe(element);
    } else {
      visibility.unobserve(element);
    }
  }

  function updateTree(node: Node) {
    if (!(node instanceof Element)) return;
    updateTarget(node);
    node.querySelectorAll(revealMarker).forEach(updateTarget);
  }

  document.querySelectorAll(revealMarker).forEach(updateTarget);
  const changes = typeof MutationObserver === "undefined" ? null : new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes" && mutation.target instanceof Element) {
        updateTarget(mutation.target);
      }
      mutation.removedNodes.forEach(updateTree);
      mutation.addedNodes.forEach(updateTree);
    }
  });
  changes?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-reveal"] });

  return () => {
    changes?.disconnect();
    visibility.disconnect();
  };
}

export function MotionEffects() {
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;

    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let frame: number | null = null;
    let previousOffset = 0;
    let stopReveals: (() => void) | undefined;

    function scheduleParallax() {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const offset = Math.min(40, Math.max(0, window.scrollY * 0.12));
        if (offset === previousOffset) return;
        layer?.style.setProperty("--parallax-offset", `${offset}px`);
        previousOffset = offset;
      });
    }

    function stopMotion() {
      stopReveals?.();
      stopReveals = undefined;
      window.removeEventListener("scroll", scheduleParallax);
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      previousOffset = 0;
      layer?.style.removeProperty("--parallax-offset");
    }

    function updatePreference() {
      stopMotion();
      if (preference?.matches) return;
      stopReveals = observeReveals();
      window.addEventListener("scroll", scheduleParallax, { passive: true });
      scheduleParallax();
    }

    updatePreference();
    preference?.addEventListener("change", updatePreference);
    return () => {
      preference?.removeEventListener("change", updatePreference);
      stopMotion();
    };
  }, []);

  return (
    <div className="motion-backdrop" aria-hidden="true">
      <div ref={layerRef} className="motion-backdrop-layer" />
    </div>
  );
}
