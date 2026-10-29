import { useRef, useState } from 'react';
import Dialog from '../../Dialog.jsx';
import DetailImage from '../../DetailImage.jsx';
import { apiUrl } from '../../api.js';

export default function WorkflowImagePreview({ images, index, runId, chosen, onChoose, onIndex, onClose, onAccept }) {
  const [error, setError] = useState(''), [dimensions, setDimensions] = useState(null);
  const stage = useRef(null);
  const item = images[index];
  if (!item) return null;
  const src = item.src || apiUrl(`/api/workflow-artifacts/${item.artifactId}/media?runId=${runId}`);
  function navigate(next) { setError(''); setDimensions(null); onIndex(next); stage.current?.focus({ preventScroll: true }); }
  function decide(keep) {
    onChoose(item.artifactId, keep);
    if (index < images.length - 1) navigate(index + 1);
  }
  return <Dialog open label={onChoose ? '审核图片预览' : '图片预览'} className="workflow-image-preview" onClose={onClose} onKeyDown={(event) => {
    event.stopPropagation();
    if (event.target.closest('input, textarea, select') || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); navigate(index - 1); }
    if (event.key === 'ArrowRight' && index < images.length - 1) { event.preventDefault(); navigate(index + 1); }
    if (onChoose && !event.repeat && ['a', 'x'].includes(event.key.toLowerCase())) { event.preventDefault(); decide(event.key.toLowerCase() === 'a'); }
  }}>
    <header><strong>图片 {index + 1} / {images.length}{dimensions && <small> · {dimensions}</small>}</strong><button type="button" onClick={onClose}>关闭预览</button></header>
    <div ref={stage} tabIndex={0} className="workflow-image-preview-stage"><DetailImage key={src} src={src} alt={`${onChoose ? '审核' : ''}原图 ${index + 1}`} onLoad={(event) => setDimensions(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)} onError={() => setError('图片加载失败，请关闭预览后重试。')} />{error && <p role="alert">{error}</p>}</div>
    {onChoose && <nav className="workflow-review-filmstrip" aria-label="切换审核图片">{images.map((image, at) => <button type="button" key={image.artifactId} aria-label={`切换到图片 ${at + 1}`} aria-current={at === index ? 'true' : undefined} onClick={() => navigate(at)}><img alt="" src={apiUrl(`/api/workflow-artifacts/${image.artifactId}/media?runId=${runId}`)} /><span>{at + 1} · {chosen.includes(image.artifactId) ? '保留' : '已排除'}</span></button>)}</nav>}
    <footer><div className="workflow-actions"><button type="button" disabled={index === 0} onClick={() => navigate(index - 1)}>上一张</button><button type="button" disabled={index === images.length - 1} onClick={() => navigate(index + 1)}>下一张</button></div>{onChoose && <div className="workflow-review-decisions"><strong aria-live="polite">当前：{chosen.includes(item.artifactId) ? '保留' : '已排除'}</strong><button type="button" onClick={() => decide(false)}>排除{index < images.length - 1 ? '并下一张' : '这张'} (X)</button><button type="button" onClick={() => decide(true)}>保留{index < images.length - 1 ? '并下一张' : '这张'} (A)</button></div>}{onAccept && <button type="button" className="primary" disabled={!chosen.length} onClick={onAccept}>通过选中的 {chosen.length} / {images.length} 张</button>}</footer>
    {onChoose && <small>← → 切换 · A 保留 · X 排除 · 选择暂存，点击“通过选中的”后提交；关闭预览可继续挑选。</small>}
  </Dialog>;
}
