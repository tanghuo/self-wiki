import { useEffect, useRef, useState } from "react";
import { Play, Video } from "lucide-react";
import { apiUrl, request } from "./api.js";
import { scheduleVideoCover } from "./videoCoverQueue.js";
import { elementLabel } from "../../shared/domain/elements.js";

// Bound the memory used by covers; no original video bytes are retained here.
const covers = new Map();

function frameCanvas(video) {
  const canvas = document.createElement("canvas");
  const scale = Math.min(480 / video.videoWidth, 480 / video.videoHeight, 1);
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.getContext("2d", { willReadFrequently: true }).drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export default function VideoCardPreview({ element, disabled }) {
  const source = apiUrl(element.video.url);
  const root = useRef(null);
  const player = useRef(null);
  const playbackPosition = useRef(null);
  const [cover, setCover] = useState(() => covers.get(source));
  const [pausedFrame, setPausedFrame] = useState(null);
  const [cacheChecked, setCacheChecked] = useState(() => covers.has(source));
  const [visible, setVisible] = useState(false);
  const [near, setNear] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(!document.hidden);
  const [coverSlot, setCoverSlot] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [duration, setDuration] = useState(cover?.duration);
  const attempt = useRef(0);
  const enabled = !element.deletedAt;

  useEffect(() => {
    if (!enabled || !near || !documentVisible || cacheChecked) return;
    let cancelled = false;
    const controller = new AbortController();
    request(`/api/elements/${element.id}/video-cover`, { signal: controller.signal }).then(({ cover: saved }) => {
      if (cancelled || !saved) return;
      covers.set(source, saved);
      if (covers.size > 128) covers.delete(covers.keys().next().value);
      setCover(saved); setDuration(saved.duration);
    }).catch(() => { /* A cache read failure must not prevent local preview. */ })
      .finally(() => { if (!cancelled) setCacheChecked(true); });
    return () => { cancelled = true; controller.abort(); };
  }, [enabled, near, documentVisible, cacheChecked, element.id, source]);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry.isIntersecting);
      if (!entry.isIntersecting) setHovered(false);
    });
    observer.observe(root.current);
    const prefetch = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin: "1000px" });
    prefetch.observe(root.current);
    const hide = () => { setDocumentVisible(!document.hidden); if (document.hidden) setHovered(false); };
    document.addEventListener("visibilitychange", hide);
    return () => { observer.disconnect(); prefetch.disconnect(); document.removeEventListener("visibilitychange", hide); };
  }, []);

  const needsCover = enabled && near && documentVisible && cacheChecked && !cover && !failed;
  useEffect(() => {
    if (!needsCover) return;
    let timer;
    const release = scheduleVideoCover(() => {
      setCoverSlot(true);
      timer = setTimeout(() => setFailed(true), 15000);
    });
    return () => { clearTimeout(timer); release(); setCoverSlot(false); };
  }, [needsCover]);

  const previewing = documentVisible && enabled && !disabled && visible && hovered && Boolean(cover) && !failed;
  const load = previewing || (needsCover && coverSlot);
  useEffect(() => {
    const video = player.current;
    if (!load) return;
    video.src = source;
    video.load();
    return () => {
      video.pause();
      if (video.readyState >= 1) playbackPosition.current = { source, time: video.currentTime };
      if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
        try {
          setPausedFrame({ source, url: frameCanvas(video).toDataURL("image/jpeg", 0.8) });
        } catch { /* Keep the previous cover if this frame cannot be captured. */ }
      }
      video.removeAttribute("src");
      video.load();
    };
  }, [load, source]);

  useEffect(() => {
    const video = player.current;
    if (previewing) {
      video.play().catch(() => setPlaying(false));
    } else { video.pause(); setPlaying(false); }
    return () => video.pause();
  }, [previewing, cover]);

  function metadata() {
    const video = player.current;
    if (!Number.isFinite(video.duration) || video.duration <= 0) { setFailed(true); return; }
    setDuration(video.duration);
    if (cover) {
      const position = playbackPosition.current;
      video.currentTime = position?.source === source ? position.time : cover.time;
    } else video.currentTime = Math.min(1, video.duration / 4);
  }

  function capture() {
    const video = player.current;
    if (cover || !video.videoWidth || video.readyState < 2) return;
    try {
      const canvas = frameCanvas(video);
      const context = canvas.getContext("2d");
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let brightness = 0;
      for (let i = 0; i < pixels.length; i += 4) brightness += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
      if (brightness / (pixels.length / 4) < 12 && attempt.current < 3) {
        attempt.current += 1;
        video.currentTime = video.duration * (attempt.current / 4);
        return;
      }
      const result = { url: canvas.toDataURL("image/jpeg", 0.8), duration: video.duration, time: video.currentTime };
      covers.set(source, result);
      if (covers.size > 128) covers.delete(covers.keys().next().value);
      setCover(result);
      request(`/api/elements/${element.id}/video-cover`, { method: "PUT", body: JSON.stringify(result) })
        .catch(() => { /* Keep the in-memory cover if disk caching is unavailable. */ });
    } catch { setFailed(true); }
  }

  const seconds = Math.floor(duration || 0);
  const timeLabel = seconds >= 3600
    ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return <div ref={root} className="wiki-card-video" onPointerEnter={(event) => { if (event.pointerType !== "touch") setHovered(true); }} onPointerLeave={() => setHovered(false)}>
    <div className={`wiki-card-video-cover${playing ? " is-playing" : ""}`}>
      <video ref={player} muted playsInline loop preload="metadata" crossOrigin="anonymous" aria-hidden="true" tabIndex={-1}
        onLoadedMetadata={metadata} onSeeked={capture} onPlaying={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onError={() => { if (player.current?.getAttribute("src")) setFailed(true); }} />
      {cover ? <img src={pausedFrame?.source === source ? pausedFrame.url : cover.url} alt="" /> : <span className="wiki-card-video-placeholder"><Video size={34} /><span>{failed ? "封面无法加载 · 点击播放" : element.deletedAt ? "视频" : "正在提取封面…"}</span></span>}
      {cover && !playing && <span className="wiki-card-video-play"><Play size={26} fill="currentColor" /></span>}
      {playing && <span className="wiki-card-video-badge">静音预览</span>}
      {duration > 0 && <span className="wiki-card-video-duration" aria-label={`视频时长 ${timeLabel}`}>{timeLabel}</span>}
    </div>
    <div className="wiki-card-video-info"><strong title={elementLabel(element)}>{elementLabel(element)}</strong><small>{(element.video.byteSize / 1024 / 1024).toFixed(1)} MiB</small></div>
  </div>;
}
