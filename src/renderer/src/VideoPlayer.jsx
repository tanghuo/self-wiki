import { useEffect, useRef, useState } from "react";
import { apiUrl } from "./api.js";
import { elementLabel } from "../../shared/domain/elements.js";

export default function VideoPlayer({ element, visible = true, playerRef }) {
  const [failed, setFailed] = useState(false);
  const localPlayer = useRef(null);
  const player = playerRef || localPlayer;
  useEffect(() => {
    const node = player.current;
    if (!visible) node?.pause();
    // Activity preserves DOM when hidden, but cleans up effects.
    return () => node?.pause();
  }, [visible]);
  return <div className="wiki-video-player">
    <video ref={player} key={element.id} controls preload="metadata" playsInline src={apiUrl(element.video.url)} aria-label={`播放视频：${elementLabel(element)}`} onError={() => setFailed(true)} onLoadedMetadata={() => setFailed(false)} />
    {failed && <p className="wiki-error" role="alert">视频无法播放，可能是浏览器不支持此编码或文件无法读取。<a href={apiUrl(`/api/elements/${element.id}/download`)} download>下载原视频</a>后使用本地播放器打开。</p>}
  </div>;
}
