import { useLayoutEffect, useRef, useState } from "react";

export default function DetailImage({ src, alt, onLoad, onError, onContextMenu, inert }) {
  const stage = useRef(null), image = useRef(null), pan = useRef(null);
  const view = useRef({ scale: 1, x: 0, y: 0 });
  const [transform, setTransform] = useState(view.current);
  const [loaded, setLoaded] = useState(false);

  useLayoutEffect(() => {
    if (image.current.complete && image.current.naturalWidth) setLoaded(true);
  }, [src]);

  function updateView(scale, x = 0, y = 0) {
    const maxX = Math.max(0, (image.current.clientWidth * scale - stage.current.clientWidth) / 2);
    const maxY = Math.max(0, (image.current.clientHeight * scale - stage.current.clientHeight) / 2);
    view.current = { scale, x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
    setTransform(view.current);
  }

  function reset() { pan.current = null; if (image.current && stage.current) updateView(1); }

  useLayoutEffect(() => {
    const target = image.current;
    function wheel(event) {
      if (!target.complete || !target.naturalWidth || !event.deltaY) return;
      // React's delegated wheel listener is passive; cancel page scrolling on the image itself.
      event.preventDefault();
      const current = view.current;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.current.clientHeight : 1);
      const scale = Math.max(1, Math.min(8, current.scale * Math.exp(-Math.max(-100, Math.min(100, delta)) * .002)));
      const rect = target.getBoundingClientRect(), ratio = scale / current.scale;
      pan.current = null;
      updateView(scale,
        current.x + (event.clientX - rect.left - rect.width / 2) * (1 - ratio),
        current.y + (event.clientY - rect.top - rect.height / 2) * (1 - ratio));
    }
    target.addEventListener("wheel", wheel, { passive: false });
    const observer = new ResizeObserver(reset);
    observer.observe(stage.current);
    observer.observe(target);
    return () => { target.removeEventListener("wheel", wheel); observer.disconnect(); };
  }, []);

  return <div className="wiki-image-viewer" inert={inert}>
    <div ref={stage} className="wiki-original" onContextMenu={onContextMenu}>
      <img ref={image} src={src} alt={alt} draggable={false} className={transform.scale > 1 ? "is-zoomed" : ""}
        style={{ opacity: loaded ? 1 : 0, transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
        onLoad={(event) => { setLoaded(true); reset(); onLoad?.(event); }} onError={(event) => { setLoaded(false); onError?.(event); }}
        onPointerDown={(event) => {
          if (view.current.scale <= 1 || event.button !== 0 || !event.isPrimary) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          pan.current = { id: event.pointerId, clientX: event.clientX, clientY: event.clientY, ...view.current };
        }} onPointerMove={(event) => {
          const start = pan.current;
          if (!start || start.id !== event.pointerId) return;
          updateView(start.scale, start.x + event.clientX - start.clientX, start.y + event.clientY - start.clientY);
        }} onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          pan.current = null;
        }} onPointerCancel={() => { pan.current = null; }} onLostPointerCapture={() => { pan.current = null; }} />
    </div>
    <div className="wiki-image-tools"><span>滚轮缩放 · 放大后可拖动</span><button className="text-button" disabled={transform.scale === 1} onClick={reset}>恢复全图</button></div>
  </div>;
}
