import { test } from "node:test";
import assert from "node:assert/strict";

test("image preloading prioritizes nearby cards, shares four slots and releases cancelled cards", async (t) => {
  const original = Object.fromEntries(["document", "innerHeight", "IntersectionObserver"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const listeners = new Map(), observers = [];
  globalThis.document = { hidden: false, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
  globalThis.innerHeight = 800;
  globalThis.IntersectionObserver = class {
    constructor(callback, options) { this.callback = callback; this.options = options; this.nodes = new Set(); observers.push(this); }
    observe(node) { this.nodes.add(node); }
    unobserve(node) { this.nodes.delete(node); }
    disconnect() { this.nodes.clear(); }
  };
  const { preloadImage } = await import("../src/renderer/src/imagePreload.js");
  const nodes = [3800, 100, 1800, -1400, 200, 2600].map((top) => ({ getBoundingClientRect: () => ({ top, bottom: top + 100, width: 200, height: 100 }) }));
  const started = [];
  const release = nodes.map((node, index) => preloadImage(node, () => started.push(index)));
  t.after(() => release.forEach((finish) => finish()));
  assert.equal(observers.length, 1);
  observers[0].callback(nodes.map((target) => ({ target, isIntersecting: true })));
  assert.deepEqual(started, [1, 4, 2, 3]);
  release[0](); // An offscreen card is unmounted before its request starts.
  release[1](); release[1](); // A late onLoad after unmount must not release two slots.
  await Promise.resolve();
  assert.deepEqual(started, [1, 4, 2, 3, 5]);
  document.hidden = true;
  const hiddenNode = { getBoundingClientRect: () => ({ top: 0, bottom: 100, width: 200, height: 100 }) };
  const finishHidden = preloadImage(hiddenNode, () => started.push("resumed"));
  release.push(finishHidden);
  observers[0].callback([{ target: hiddenNode, isIntersecting: true }]);
  release[2](); await Promise.resolve();
  assert.equal(started.includes("resumed"), false);
  document.hidden = false; listeners.get("visibilitychange")();
  assert.equal(started.at(-1), "resumed");
  release.forEach((finish) => finish());
  assert.equal(observers[0].nodes.size, 0);
  assert.equal(listeners.size, 0);
});
