import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

/** Compact QR for a URL; renders a canvas. */
export default function QrCode({ value, size = 180, label = "二维码" }) {
  const canvas = useRef(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!value || !canvas.current) return;
    let cancelled = false;
    setError("");
    QRCode.toCanvas(canvas.current, value, {
      width: size,
      margin: 2,
      color: { dark: "#1a1a1a", light: "#ffffff" },
      errorCorrectionLevel: "M",
    }).catch((failure) => { if (!cancelled) setError(failure.message || "无法生成二维码"); });
    return () => { cancelled = true; };
  }, [value, size]);
  if (!value) return null;
  return <figure className="lan-qr" aria-label={label}>
    <canvas ref={canvas} width={size} height={size} />
    {error && <figcaption className="wiki-error">{error}</figcaption>}
  </figure>;
}
