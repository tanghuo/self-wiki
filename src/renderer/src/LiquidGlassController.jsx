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

function isLibraryFloatingSearch(element) {
  return element && getComputedStyle(element).position === "fixed";
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
      if (!element || surfaces.some((entry) => entry.element === element || (kind === "plate" && entry.source === element))) return;
      if (kind === "plate") {
        const source = element;
        const plate = document.createElement("div");
        plate.className = "lg-plate";
        plate.setAttribute("aria-hidden", "true");
        document.body.appendChild(plate);
        source.classList.add("lg-has-plate");
        const sync = () => {
          const box = source.getBoundingClientRect();
          Object.assign(plate.style, {
            position: "fixed", left: `${box.left}px`, top: `${box.top}px`,
            width: `${Math.max(0, box.width)}px`, height: `${Math.max(0, box.height)}px`,
            borderRadius: "999px", zIndex: "11", pointerEvents: "none",
          });
        };
        const rebuild = () => {
          if (!source.isConnected) return;
          sync();
          if (plate.clientWidth && plate.clientHeight) buildLiquidFilter(plate, soften(SURFACE_OPTS.plate, atmosphere));
        };
        const observer = new ResizeObserver(() => {
          clearTimeout(rebuildTimer);
          rebuildTimer = window.setTimeout(rebuild, 80);
        });
        observer.observe(source);
        window.addEventListener("resize", rebuild);
        rebuild();
        surfaces.push({
          element: plate, kind, source, rebuild,
          dispose: () => {
            observer.disconnect();
            window.removeEventListener("resize", rebuild);
            clearLiquidFilter(plate);
            plate.remove();
            source.classList.remove("lg-has-plate");
          },
        });
        return;
      }
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
        const alive = entry.kind === "plate" ? entry.source?.isConnected : entry.element?.isConnected;
        if (!alive) { entry.dispose(); surfaces.splice(i, 1); }
      }
      attach(document.querySelector(".wiki-sidebar"), "sidebar");
      const search = document.querySelector(".wiki-main .wiki-toolbar .wiki-search");
      if (isLibraryFloatingSearch(search)) attach(search, "search");
      const toolbar = document.querySelector(".wiki-main .wiki-toolbar");
      if (toolbar && getComputedStyle(toolbar).position === "fixed"
        && !document.querySelector(".app-layout.agent-docked")) {
        attach(toolbar, "plate");
      }
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
