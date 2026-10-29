// Liquid glass: SVG feDisplacementMap used as backdrop-filter (Chromium / Electron).
// No RGB fringe — one displacement pass. Callers pause refraction while scrolling.

const NS = "http://www.w3.org/2000/svg";

export function supportsLiquidGlass() {
  try { return typeof CSS !== "undefined" && CSS.supports("backdrop-filter", "url(#liquid-glass-probe)"); }
  catch { return false; }
}

export function prefersReducedTransparency() {
  try { return window.matchMedia("(prefers-reduced-transparency: reduce)").matches; }
  catch { return false; }
}

function roundedRectSdf(x, y, hw, hh, r) {
  const qx = Math.abs(x) - hw + r, qy = Math.abs(y) - hh + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

/** Build an R/G displacement map: edge band pulls backdrop inward along the SDF normal. */
export function makeDisplacementMap(width, height, radius, bezel) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(width, height);
  const data = image.data;
  const hw = width / 2, hh = height / 2;
  const r = Math.min(radius, hw, hh);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5 - hw, py = y + 0.5 - hh;
      const distance = -roundedRectSdf(px, py, hw, hh, r);
      let dx = 0, dy = 0;
      if (distance > 0 && distance < bezel) {
        const e = 0.5;
        const nx = roundedRectSdf(px + e, py, hw, hh, r) - roundedRectSdf(px - e, py, hw, hh, r);
        const ny = roundedRectSdf(px, py + e, hw, hh, r) - roundedRectSdf(px, py - e, hw, hh, r);
        const length = Math.hypot(nx, ny) || 1;
        const k = 1 - distance / bezel;
        const magnitude = Math.sqrt(1 - (1 - k) * (1 - k)) * k;
        dx = -nx / length * magnitude;
        dy = -ny / length * magnitude;
      }
      const i = (y * width + x) * 4;
      data[i] = 128 + dx * 127;
      data[i + 1] = 128 + dy * 127;
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

let filterHost = null;
let filterSeq = 0;

function ensureHost() {
  if (filterHost?.isConnected) return filterHost;
  filterHost = document.createElementNS(NS, "svg");
  filterHost.setAttribute("width", "0");
  filterHost.setAttribute("height", "0");
  filterHost.setAttribute("aria-hidden", "true");
  filterHost.style.cssText = "position:fixed;width:0;height:0;pointer-events:none";
  document.body.appendChild(filterHost);
  return filterHost;
}

export function buildLiquidFilter(element, options) {
  const rect = element.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const radius = Math.min(parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0, width / 2, height / 2);
  const id = element.dataset.lgId || (element.dataset.lgId = `lg-${++filterSeq}`);
  const host = ensureHost();
  host.querySelector(`#${CSS.escape(id)}`)?.remove();
  const filter = document.createElementNS(NS, "filter");
  filter.id = id;
  for (const [key, value] of Object.entries({
    x: "0", y: "0", width: String(width), height: String(height),
    filterUnits: "userSpaceOnUse", primitiveUnits: "userSpaceOnUse",
    "color-interpolation-filters": "sRGB",
  })) filter.setAttribute(key, value);
  const map = makeDisplacementMap(width, height, radius, options.bezel);
  filter.innerHTML = `
    <feGaussianBlur in="SourceGraphic" stdDeviation="${options.blur}" result="frost"/>
    <feImage href="${map}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="none" result="map"/>
    <feDisplacementMap in="frost" in2="map" scale="${options.scale}" xChannelSelector="R" yChannelSelector="G"/>`;
  host.appendChild(filter);
  element.style.setProperty("--lg-filter", `url(#${id})`);
  if (options.alpha != null) element.style.setProperty("--lg-alpha", String(options.alpha));
  element.classList.add("lg-glass");
  if (!element.querySelector(":scope > .lg-sheen")) {
    const sheen = document.createElement("span");
    sheen.className = "lg-sheen";
    sheen.setAttribute("aria-hidden", "true");
    element.prepend(sheen);
  }
  return id;
}

export function clearLiquidFilter(element) {
  if (!element) return;
  const id = element.dataset.lgId;
  if (id) filterHost?.querySelector(`#${CSS.escape(id)}`)?.remove();
  element.classList.remove("lg-glass");
  element.style.removeProperty("--lg-filter");
  element.style.removeProperty("--lg-alpha");
  element.querySelector(":scope > .lg-sheen")?.remove();
  delete element.dataset.lgId;
}

/** Track pointer for specular highlight; returns disposer. */
export function trackLiquidPointer(getElements) {
  const onMove = (event) => {
    for (const element of getElements()) {
      if (!element?.isConnected) continue;
      const box = element.getBoundingClientRect();
      element.style.setProperty("--lg-x", `${event.clientX - box.left}px`);
      element.style.setProperty("--lg-y", `${event.clientY - box.top}px`);
      element.style.setProperty("--lg-a", `${Math.atan2(event.clientY - (box.top + box.height / 2), event.clientX - (box.left + box.width / 2)) * 180 / Math.PI + 90}deg`);
    }
  };
  window.addEventListener("pointermove", onMove, { passive: true });
  return () => window.removeEventListener("pointermove", onMove);
}

/** While scrolling, set data-lg-scrolling so CSS drops the SVG filter. */
export function pauseRefractionWhileScrolling(root = document) {
  let timer = 0;
  const onScroll = () => {
    document.documentElement.dataset.lgScrolling = "1";
    clearTimeout(timer);
    timer = window.setTimeout(() => { delete document.documentElement.dataset.lgScrolling; }, 140);
  };
  root.addEventListener("scroll", onScroll, { passive: true, capture: true });
  return () => {
    root.removeEventListener("scroll", onScroll, { capture: true });
    clearTimeout(timer);
    delete document.documentElement.dataset.lgScrolling;
  };
}
