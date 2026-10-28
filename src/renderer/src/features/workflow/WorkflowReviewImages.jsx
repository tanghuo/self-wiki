import { useState } from 'react';
import { apiUrl } from '../../api.js';
import WorkflowImagePreview from './WorkflowImagePreview.jsx';

export default function WorkflowReviewImages({ images, runId, chosen, onChange }) {
  const [previewIndex, setPreviewIndex] = useState(null);
  const selected = chosen || [];
  function choose(id, keep) { onChange(keep ? [...new Set([...selected, id])] : selected.filter((value) => value !== id)); }
  return <>
    <fieldset className="workflow-review-images"><legend>查看大图后选择要保留的图片（已选 {selected.length} / {images.length}）</legend>{images.map((item, index) => <div className="workflow-review-image" key={item.artifactId} data-chosen={selected.includes(item.artifactId)}><button type="button" className="workflow-review-preview" aria-label={`查看图片 ${index + 1} 大图`} onClick={() => setPreviewIndex(index)}><img alt={`图片 ${index + 1}`} src={apiUrl(`/api/workflow-artifacts/${item.artifactId}/media?runId=${runId}`)} /><span>查看大图</span></button><label><input type="checkbox" checked={selected.includes(item.artifactId)} onChange={(event) => choose(item.artifactId, event.target.checked)} />保留图片 {index + 1}</label></div>)}</fieldset>
    {previewIndex !== null && <WorkflowImagePreview images={images} index={previewIndex} runId={runId} chosen={selected} onChoose={choose} onIndex={setPreviewIndex} onClose={() => setPreviewIndex(null)} />}
  </>;
}
