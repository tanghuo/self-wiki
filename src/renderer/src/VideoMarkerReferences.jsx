import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import useWikiResource from "./useWikiResource.js";
import WikiPaging from "./WikiPaging.jsx";
import { markerTimeLabel } from "../../shared/domain/videoMarkers.js";

export default function VideoMarkerReferences({ id, revision, onOpen, disabled }) {
  const [page, setPage] = useState(1), [retry, setRetry] = useState(0);
  const result = useWikiResource(`/api/elements/${id}/video-references?page=${page}&pageSize=12`, `${revision}:${retry}`);
  useEffect(() => {
    if (result.data && page > result.data.pagination.pageCount) setPage(result.data.pagination.pageCount);
  }, [result.data, page]);
  return <section className="wiki-video-references" aria-label="关联的视频片段"><h2><Clock size={18} />关联的视频片段</h2>
    {result.loading && <p className="wiki-muted" role="status">正在读取视频片段…</p>}
    {result.error && <p className="wiki-error" role="alert">{result.error}<button onClick={() => setRetry((value) => value + 1)}>重试</button></p>}
    {result.data?.references.map((marker) => <article key={marker.id}><button className="text-button" disabled={disabled} onClick={() => onOpen(marker.videoId, undefined, marker.id)}>{marker.videoName} · {markerTimeLabel(marker)}</button>{marker.body && <p>{marker.body}</p>}</article>)}
    <WikiPaging pagination={result.data?.pagination} onPage={setPage} disabled={disabled || result.loading} />
  </section>;
}
