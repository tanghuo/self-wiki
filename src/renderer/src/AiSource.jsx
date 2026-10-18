export default function AiSource({ resultId, modified = false, onOpen, disabled = false }) {
  if (!resultId) return null;
  const title = `AI 添加 · 整理 #${resultId}${modified ? " · 人工已修改" : ""}`;
  if (!onOpen) return <span className="ai-source" title={title}>AI{modified ? "·已改" : ""}</span>;
  return <button className="ai-source" title={`${title}，点击查看记录`} aria-label={`查看 AI 整理 ${resultId}`} aria-haspopup="dialog" disabled={disabled} onClick={() => onOpen(resultId)}>AI{modified ? "·已改" : ""}</button>;
}
