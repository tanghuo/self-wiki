import { useLayoutEffect, useRef } from "react";

export default function WikiGrid({ masonry, cardWidth, children }) {
  const grid = useRef(null);
  useLayoutEffect(() => {
    const node = grid.current;
    let cards = new Set(node.children);
    if (!masonry) {
      cards.forEach((card) => card.style.removeProperty("grid-row-end"));
      return;
    }
    function measure(entries) {
      // One-pixel rows preserve DOM/keyboard order while packing mixed card heights.
      // Ignore hidden lists so returning from a detail keeps the previous layout.
      const gap = parseFloat(getComputedStyle(node).columnGap);
      const measured = entries ? entries.map((entry) => ({ card: entry.target,
        height: entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height }))
        : [...cards].map((card) => ({ card, height: card.getBoundingClientRect().height }));
      measured.forEach(({ card, height }) => {
        const span = `span ${Math.ceil(height + gap)}`;
        if (height > 0 && card.style.gridRowEnd !== span) card.style.gridRowEnd = span;
      });
    }
    // ResizeObserver runs before paint; an extra animation frame exposes stale row spans.
    const observer = new ResizeObserver(measure);
    cards.forEach((card) => observer.observe(card));
    measure();
    // A card can become a stack without changing its React key. Follow actual DOM
    // replacements/appends instead of reinstalling every observer on each list render.
    const changes = new MutationObserver(() => {
      const next = new Set(node.children), added = [];
      for (const card of cards) if (!next.has(card)) observer.unobserve(card);
      for (const card of next) if (!cards.has(card)) { observer.observe(card); added.push({ target: card }); }
      cards = next;
      if (added.length) measure(added);
    });
    changes.observe(node, { childList: true });
    // Retain row spans during rerenders so measuring never collapses the scrollable height.
    return () => { observer.disconnect(); changes.disconnect(); };
  }, [masonry, cardWidth]);
  return <div ref={grid} className={`wiki-grid${masonry ? " wiki-masonry" : ""}`} style={masonry ? { "--wiki-card-width": `${cardWidth}px` } : undefined}>{children}</div>;
}
