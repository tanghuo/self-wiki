import { useState } from 'react';
import { apiUrl } from '../../api.js';
import WorkflowImagePreview from './WorkflowImagePreview.jsx';

export default function WorkflowArtifactImages({ images, runId, className = 'workflow-result-images', alt = '结果图片' }) {
  const [previewIndex, setPreviewIndex] = useState(null);
  return <>
    <div className={className}>{images.map((item, index) => <button type="button" className="workflow-artifact-preview" key={`${item.artifactId}:${index}`} aria-label={`查看${alt} ${index + 1} 大图`} onClick={() => setPreviewIndex(index)}><img alt={`${alt} ${index + 1}`} src={apiUrl(`/api/workflow-artifacts/${item.artifactId}/media?runId=${runId}`)} /></button>)}</div>
    {previewIndex !== null && <WorkflowImagePreview images={images} index={previewIndex} runId={runId} onIndex={setPreviewIndex} onClose={() => setPreviewIndex(null)} />}
  </>;
}
