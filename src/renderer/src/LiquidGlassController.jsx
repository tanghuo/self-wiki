import { useEffect, useState } from "react";
import {
  buildLiquidFilter, clearLiquidFilter, pauseRefractionWhileScrolling,
  prefersReducedTransparency, supportsLiquidGlass, trackLiquidPointer,
} from "./liquidGlass.js";

const SURFACE_OPTS = {
  sidebar: { blur: 4, scale: 36, bezel: 24, alpha: 0.22 },
  search: { blur: 2.4, scale: 26, bezel: 11, alpha: 0.36 },
  plate: { blur: 2, scale: 26, bezel: 12, alpha: 0.26 },
};

function soften(options, atmosphere) {
  if (atmosphere !== "soft") return options;
  return {
    ...options,
    blur: options.blur + 2.5,
    scale: Math.round(options.scale * 0.55),
    bezel: Math.max(8, Math.round(options.bezel * 0.75)),
  };
}

// The floating tool layer is a structural component now (ui/FloatingLayer.jsx), so the glass
// follows the component instead of probing for position: fixed.
function isLibraryFloatingSearch(element) {
  return Boolean(element?.closest(".ui-float-search"));
}

/**
 * Applies liquid glass to the sidebar, library search capsule, and bottom filter plate.
 * Settings toggle + Chromium support + prefers-reduced-transparency gate activation.
 */
export default function LiquidGlassController({ enabled, atmosphere = "full" }) {
  const [reduced, setReduced] = useState(() => prefersReducedTransparency());

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-transparency: reduce)");
    const sync = () => setReduced(media.matches);
    sync();
    media.addEventListener?.("change", sync);
    return () => media.removeEventListener?.("change", sync);
  }, []);

  useEffect(() => {
    const supported = supportsLiquidGlass();
    const active = Boolean(enabled && supported && !reduced);
    document.documentElement.dataset.liquidGlass = active ? "on" : "off";
    document.documentElement.dataset.liquidGlassSupport = supported ? "yes" : "no";

    if (!active) {
      return () => {
        delete document.documentElement.dataset.liquidGlass;
        delete document.documentElement.dataset.liquidGlassSupport;
      };
    }

    const surfaces = [];
    let scanTimer = 0;
    let rebuildTimer = 0;

    function disposeAll() {
      for (const entry of surfaces.splice(0)) entry.dispose();
    }

    function attach(element, kind) {
      if (!element || surfaces.some((entry) => entry.element === element)) return;
      const rebuild = () => {
        if (!element.isConnected) return;
        const box = element.getBoundingClientRect();
        if (!box.width || !box.height) return;
        buildLiquidFilter(element, soften(SURFACE_OPTS[kind], atmosphere));
      };
      const observer = new ResizeObserver(() => {
        clearTimeout(rebuildTimer);
        rebuildTimer = window.setTimeout(rebuild, 80);
      });
      observer.observe(element);
      rebuild();
      surfaces.push({
        element, kind, rebuild,
        dispose: () => { observer.disconnect(); clearLiquidFilter(element); },
      });
    }

    function scan() {
      // Drop detached surfaces first.
      for (let i = surfaces.length - 1; i >= 0; i--) {
        const entry = surfaces[i];
        const alive = entry.element?.isConnected;
        if (!alive) { entry.dispose(); surfaces.splice(i, 1); }
      }
      attach(document.querySelector(".wiki-sidebar"), "sidebar");
      const search = document.querySelector(".wiki-main .ui-float-search .wiki-search");
      if (isLibraryFloatingSearch(search)) attach(search, "search");
      const toolbar = document.querySelector(".wiki-main .ui-float-capsule.wiki-toolbar");
      // The capsule is an in-flow sticky element now, so the glass goes on the capsule itself
      // (a body-level fixed plate could not follow it while the page scrolls).
      if (toolbar) attach(toolbar, "plate");
    }

    const scheduleScan = () => {
      clearTimeout(scanTimer);
      scanTimer = window.setTimeout(scan, 60);
    };

    scan();
    const stopPointer = trackLiquidPointer(() => surfaces.map((entry) => entry.element));
    const stopScroll = pauseRefractionWhileScrolling();
    const onHash = () => scheduleScan();
    window.addEventListener("hashchange", onHash);
    // Light rescan: section switches / toolbar mount without watching every DOM mutation
    // (displacement-map rebuilds on a busy media wall were collapsing masonry layout work).
    const pulse = window.setInterval(scheduleScan, 1000);

    return () => {
      window.removeEventListener("hashchange", onHash);
      clearInterval(pulse);
      stopPointer();
      stopScroll();
      clearTimeout(scanTimer);
      clearTimeout(rebuildTimer);
      disposeAll();
      delete document.documentElement.dataset.liquidGlass;
      delete document.documentElement.dataset.liquidGlassSupport;
      delete document.documentElement.dataset.lgScrolling;
    };
  }, [enabled, atmosphere, reduced]);

  return null;
}
