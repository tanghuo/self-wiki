import { useEffect, useRef, useState } from 'react';
import { apiUrl, request } from '../../api.js';
import WorkflowElementPicker from './WorkflowElementPicker.jsx';
import WorkflowImagePreview from './WorkflowImagePreview.jsx';
import { clipboardImages } from '../../contentDrafts.js';
import { maxImageBytes } from '../../../../shared/domain/elements.js';

// The editor and run form share the same values; media references never need JSON entry.
export default function WorkflowContentField({ label, type, value, onChange, renderText, showImageHelp = false, runId }) {
  const [picking, setPicking] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(null);
  const [uploading, setUploading] = useState(false), [uploadError, setUploadError] = useState('');
  const [jsonInvalid, setJsonInvalid] = useState(false);
  const fileInput = useRef(null), uploadLock = useRef(false), currentValue = useRef(value);
  const active = useRef(true), uploadController = useRef(null), currentChange = useRef(onChange);
  currentValue.current = value;
  currentChange.current = onChange;
  useEffect(() => { active.current = true; return () => { active.current = false; uploadController.current?.abort(); }; }, []);
  async function addImages(files) {
    if (uploadLock.current) return;
    const selected = [...files].filter((file) => file.type.startsWith('image/'));
    if (!selected.length) return;
    uploadLock.current = true; setUploading(true); setUploadError('');
    const controller = new AbortController(); uploadController.current = controller;
    try {
      for (const file of type === 'image' ? selected.slice(0, 1) : selected) {
        if (file.size > maxImageBytes) throw new Error('每张图片最多 25 MiB');
        if (type === 'list<image>' && currentValue.current?.length >= 1000) throw new Error('图片列表最多 1000 项');
        const ref = await request('/api/workflow-input-images', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name || '粘贴图片.png') }, body: file, signal: controller.signal });
        if (!active.current || controller.signal.aborted) return;
        const next = type === 'image' ? ref : [...(Array.isArray(currentValue.current) ? currentValue.current : []), ref];
        currentValue.current = next; currentChange.current(next);
      }
    } catch (error) { if (active.current && !controller.signal.aborted) setUploadError(error.message); }
    finally { uploadLock.current = false; if (active.current) setUploading(false); }
  }
  const images = type === 'list<image>' ? Array.isArray(value) ? value : [] : type === 'image' && value ? [value] : [];
  const previews = images.map((ref) => ({ ...ref, src: apiUrl(ref.elementId ? `/api/elements/${ref.elementId}/image` : ref.attachmentId ? `/api/workflow-input-images/${ref.attachmentId}/media` : `/api/workflow-artifacts/${ref.artifactId}/media?runId=${runId}`) }));
  const [textPreview, setTextPreview] = useState('');
  const [textReady, setTextReady] = useState(false), [textError, setTextError] = useState('');
  useEffect(() => { let alive = true; setTextPreview(''); setTextReady(false); setTextError(''); if (type === 'text' && value?.elementId) request(`/api/elements/${value.elementId}`).then((element) => { if (alive) { setTextPreview(element.body ?? element.element?.body ?? ''); setTextReady(true); } }).catch((e) => { if (alive) setTextError(e.message); }); return () => { alive = false; }; }, [type, value?.elementId]);
  const libraryText = type === 'text' && value && typeof value === 'object';
  return <div className="workflow-content-field" aria-busy={uploading} tabIndex={type.includes('image') ? 0 : undefined} aria-label={type.includes('image') ? `${label}，可粘贴图片` : undefined} onKeyDown={(event) => { if (type.includes('image') && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') event.stopPropagation(); }} onPaste={(event) => { if (!type.includes('image')) return; const files = clipboardImages(event.clipboardData); if (files.length) { event.preventDefault(); event.stopPropagation(); void addImages(files); } }}>{!(type === 'text' && renderText && !libraryText) && <strong>{label}</strong>}
    {type === 'text' && (libraryText ? <div><p>已选择资料库文字</p>{textError ? <p role="alert" className="workflow-error">{textError}</p> : <pre>{textReady ? textPreview : '读取文字…'}</pre>}<button disabled={!textReady || !!textError} onClick={() => onChange(textPreview)}>复制为可编辑文字</button></div> : renderText ? renderText(value ?? '', onChange) : <textarea aria-label={label} rows={4} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />)}
    {type === 'number' && <input aria-label={label} type="number" value={value ?? 0} onChange={(e) => onChange(Number(e.target.value))} />}
    {type === 'boolean' && <label><input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />启用</label>}
    {showImageHelp && type.includes('image') && <div className={`workflow-image-help${images.length ? ' has-images' : ''}`}><span aria-hidden="true">▧</span><strong>{images.length ? `已选择 ${images.length} 张图片` : '点击此区域，按 Ctrl+V 粘贴图片'}</strong><p>也可上传图片或从资料库选择。上传、粘贴的图片仅作为工作流附件。</p></div>}
    {type.includes('image') && <div className="workflow-content-images">{images.map((ref, index) => <div key={`${ref.elementId || ref.attachmentId || ref.artifactId}:${index}`}>
      <button type="button" className="workflow-artifact-preview" aria-label={`查看图片 ${index + 1} 大图`} onClick={() => setPreviewIndex(index)}>{ref.elementId && <img src={apiUrl(`/api/elements/${ref.elementId}/thumbnail?width=400`)} alt={`已选图片 ${index + 1}`} />}
      {ref.attachmentId && <img src={apiUrl(`/api/workflow-input-images/${ref.attachmentId}/media`)} alt={`已选图片 ${index + 1}`} />}
      {ref.artifactId && runId && <img src={apiUrl(`/api/workflow-artifacts/${ref.artifactId}/media?runId=${runId}`)} alt={`本次图片 ${index + 1}`} />}</button>
      <span>图片 {index + 1}</span><button onClick={() => onChange(type === 'image' ? undefined : images.filter((_v, i) => i !== index))}>移除</button>
      {type === 'list<image>' && <button disabled={!index} onClick={() => { const next = [...images]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; onChange(next); }}>上移</button>}
    </div>)}</div>}
    {['text', 'image', 'list<image>'].includes(type) && <button onClick={() => setPicking(true)}>从资料库选择{type === 'text' ? '文字' : '图片'}</button>}
    {type.includes('image') && <><input ref={fileInput} hidden type="file" accept="image/*" multiple={type === 'list<image>'} onChange={(event) => { void addImages(event.target.files); event.target.value = ''; }} /><button disabled={uploading} onClick={() => fileInput.current.click()}>上传图片</button>{uploading && <p role="status">正在添加图片…</p>}{uploadError && <p role="alert" className="workflow-error">{uploadError}</p>}</>}
    {!['text', 'image', 'list<image>', 'number', 'boolean'].includes(type) && <><textarea aria-label={label} aria-invalid={jsonInvalid} defaultValue={JSON.stringify(value ?? (type.startsWith('list<') ? [] : {}), null, 2)} onChange={(e) => { let parsed; try { parsed = JSON.parse(e.target.value); } catch { setJsonInvalid(true); e.target.setCustomValidity('请填写有效 JSON'); return; } setJsonInvalid(false); e.target.setCustomValidity(''); onChange(parsed); }} />{jsonInvalid && <small className="workflow-field-error">请填写有效 JSON，修正后才能运行或保存。</small>}</>}
    {previewIndex !== null && <WorkflowImagePreview images={previews} index={previewIndex} onIndex={setPreviewIndex} onClose={() => setPreviewIndex(null)} />}
    {picking && <WorkflowElementPicker kind={type === 'text' ? 'text' : 'image'} multiple={type === 'list<image>'} onClose={() => setPicking(false)} onChoose={(elements) => { const refs = elements.map((e) => ({ elementId: e.id })); onChange(type === 'list<image>' ? refs : refs[0]); setPicking(false); }} />}
  </div>;
}
