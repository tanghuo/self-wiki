import { useRef, useState } from 'react';
import Dialog from '../../Dialog.jsx';
import DetailImage from '../../DetailImage.jsx';
import { apiUrl } from '../../api.js';

export default function WorkflowImagePreview({ images, index, runId, chosen, onChoose, onIndex, onClose }) {
  const [error, setError] = useState(''), [dimensions, setDimensions] = useState(null);
  const stage = useRef(null);
  const item = images[index];
  if (!item) return null;
  const src = apiUrl(`/api/workflow-artifacts/${item.artifactId}/media?runId=${runId}`);
  function navigate(next) { setError(''); setDimensions(null); onIndex(next); stage.current?.focus({ preventScroll: true }); }
  return <Dialog open label="审核图片预览" className="workflow-image-preview" onClose={onClose} onKeyDown={(event) => {
    event.stopPropagation();
    if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); navigate(index - 1); }
    if (event.key === 'ArrowRight' && index < images.length - 1) { event.preventDefault(); navigate(index + 1); }
  }}>
    <header><strong>图片 {index + 1} / {images.length}{dimensions && <small> · {dimensions}</small>}</strong><button type="button" onClick={onClose}>关闭预览</button></header>
    <div ref={stage} tabIndex={0} className="workflow-image-preview-stage"><DetailImage key={item.artifactId} src={src} alt={`审核原图 ${index + 1}`} onLoad={(event) => setDimensions(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)} onError={() => setError('图片加载失败，请重试或打开原图查看。')} />{error && <p role="alert">{error}</p>}</div>
    <footer><div className="workflow-actions"><button type="button" disabled={index === 0} onClick={() => navigate(index - 1)}>上一张</button><button type="button" disabled={index === images.length - 1} onClick={() => navigate(index + 1)}>下一张</button><a href={src} target="_blank" rel="noreferrer">打开原图</a></div><label><input type="checkbox" checked={chosen.includes(item.artifactId)} onChange={(event) => onChoose(item.artifactId, event.target.checked)} />保留这张图片</label></footer>
  </Dialog>;
}
