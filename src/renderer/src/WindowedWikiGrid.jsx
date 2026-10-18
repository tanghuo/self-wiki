import { Children, useLayoutEffect, useRef, useState } from "react";
import WikiGrid from "./WikiGrid.jsx";

// Keep small layout blocks, not every decoded image/video, alive during long browsing.
function GridWindow({ children, masonry, cardWidth, first }) {
  const root = useRef(null), measured = useRef(null);
  const [visible, setVisible] = useState(first);
  const [height, setHeight] = useState(1);
  const contentKey = children.map((child) => {
    const element = child.props.element;
    return `${child.key}:${element.updatedAt || ""}:${element.image?.width || ""}:${element.image?.height || ""}`;
  }).join("|");
  useLayoutEffect(() => {
    const node = root.current;
    function estimate() {
      const width = node.getBoundingClientRect().width;
      if (!width) return;
      if (measured.current?.width === width && measured.current.cardWidth === cardWidth && measured.current.masonry === masonry && measured.current.count === children.length) {
        setHeight(measured.current.height); return;
      }
      const columns = Math.max(1, Math.floor((width + 14) / ((masonry ? cardWidth : 220) + 14)));
      const cell = (width - (columns - 1) * 14) / columns;
      const total = children.reduce((sum, child) => {
        const element = child.props.element;
        const ratio = element.image?.width / element.image?.height;
        return sum + (masonry && ratio ? cell / ratio : element.kind === "text" ? 240 : cell * .75) + 16;
      }, 0);
      setHeight(Math.max(140, total / columns));
    }
    estimate();
    const observer = new ResizeObserver(() => {
      if (visible) {
        const rect = node.getBoundingClientRect();
        if (rect.height > 0 && rect.width > 0) {
          measured.current = { width: rect.width, height: rect.height, cardWidth, masonry, count: children.length };
          setHeight(rect.height);
        }
      } else estimate();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible, cardWidth, masonry, contentKey]);
  useLayoutEffect(() => {
    const node = root.current;
    const observer = new IntersectionObserver(([entry]) => {
      // Preserve the focused block, including keyboard navigation and open card menus.
      if (node.getClientRects().length) setVisible(entry.isIntersecting || node.contains(document.activeElement));
    }, { rootMargin: "4000px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <div ref={root} className="wiki-grid-window" style={visible ? undefined : { height }}>
    {visible && <WikiGrid masonry={masonry} cardWidth={cardWidth}>{children}</WikiGrid>}
  </div>;
}

export default function WindowedWikiGrid({ children, ...props }) {
  const cards = Children.toArray(children), blocks = [];
  for (let index = 0; index < cards.length; index += 36) {
    const group = cards.slice(index, index + 36);
    blocks.push(<GridWindow key={index} {...props} first={index === 0}>{group}</GridWindow>);
  }
  return blocks;
}
