import { MessageCircle } from "lucide-react";
import { apiUrl } from "./api.js";
import useWikiResource from "./useWikiResource.js";

export default function SessionPreview({ element, contextId }) {
  const preview = useWikiResource(`/api/elements/${element.id}/conversation${contextId ? `?from=${contextId}` : ""}`);
  const data = preview.data;
  return <section className="wiki-session-preview" aria-label="会话摘录">
    {preview.loading && <p role="status">正在读取会话…</p>}
    {preview.error && <p role="alert">{preview.error}</p>}
    {data && <>
      <div className="wiki-session-preview-heading"><h2>会话摘录</h2><a className="button" href={`#agent?session=${data.sessionId}${data.turnId ? `&turn=${data.turnId}` : ""}`}><MessageCircle size={15} />打开会话</a></div>
      {data.turns.length === 0 && <p className="wiki-muted">会话还没有内容。</p>}
      {data.turns.map((turn) => <div className="wiki-session-exchange" key={turn.id} data-current={turn.id === data.turnId || undefined}>
        <div className="wiki-session-message" data-role="user"><span>你</span><pre>{turn.text}</pre></div>
        {(turn.answer || turn.images.length > 0) && <div className="wiki-session-message" data-role="assistant"><span>Agent</span>{turn.answer && <pre>{turn.answer}</pre>}<div className="wiki-session-images">{turn.images.map((url) => <img key={url} src={apiUrl(url)} alt="会话中的图片" loading="lazy" />)}</div></div>}
      </div>)}
      {data.turns.length > 0 && <p className="wiki-muted">展示附近的对话片段，打开会话可查看完整上下文。</p>}
    </>}
  </section>;
}
