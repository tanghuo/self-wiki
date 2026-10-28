import { useEffect, useState } from 'react';
import { apiUrl, request } from '../../api.js';
import WorkflowElementPicker from './WorkflowElementPicker.jsx';

// The editor and run form share the same values; media references never need JSON entry.
export default function WorkflowContentField({ label, type, value, onChange, renderText }) {
  const [picking, setPicking] = useState(false);
  const images = type === 'list<image>' ? Array.isArray(value) ? value : [] : type === 'image' && value ? [value] : [];
  const [textPreview, setTextPreview] = useState('');
  useEffect(() => { let alive = true; setTextPreview(''); if (type === 'text' && value?.elementId) request(`/api/elements/${value.elementId}`).then((element) => { if (alive) setTextPreview(element.body || element.element?.body || ''); }).catch((e) => { if (alive) setTextPreview(e.message); }); return () => { alive = false; }; }, [type, value?.elementId]);
  const libraryText = type === 'text' && value && typeof value === 'object';
  return <div className="workflow-content-field">{!(type === 'text' && renderText && !libraryText) && <strong>{label}</strong>}
    {type === 'text' && (libraryText ? <div><p>已选择资料库文字</p><pre>{textPreview || '读取文字…'}</pre><button onClick={() => onChange(textPreview)}>复制为可编辑文字</button></div> : renderText ? renderText(value ?? '', onChange) : <textarea aria-label={label} rows={4} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />)}
    {type === 'number' && <input aria-label={label} type="number" value={value ?? 0} onChange={(e) => onChange(Number(e.target.value))} />}
    {type === 'boolean' && <label><input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />启用</label>}
    {type.includes('image') && <div className="workflow-content-images">{images.map((ref, index) => <div key={`${ref.elementId || ref.artifactId}:${index}`}>
      {ref.elementId && <img src={apiUrl(`/api/elements/${ref.elementId}/thumbnail?width=200`)} alt={`已选图片 ${index + 1}`} />}
      <span>图片 {index + 1}</span><button onClick={() => onChange(type === 'image' ? undefined : images.filter((_v, i) => i !== index))}>移除</button>
      {type === 'list<image>' && <button disabled={!index} onClick={() => { const next = [...images]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; onChange(next); }}>上移</button>}
    </div>)}</div>}
    {['text', 'image', 'list<image>'].includes(type) && <button onClick={() => setPicking(true)}>从资料库选择{type === 'text' ? '文字' : '图片'}</button>}
    {!['text', 'image', 'list<image>', 'number', 'boolean'].includes(type) && <textarea aria-label={label} defaultValue={JSON.stringify(value ?? (type.startsWith('list<') ? [] : {}), null, 2)} onBlur={(e) => { try { onChange(JSON.parse(e.target.value)); e.target.setCustomValidity(''); } catch { e.target.setCustomValidity('请填写有效 JSON'); e.target.reportValidity(); } }} />}
    {picking && <WorkflowElementPicker kind={type === 'text' ? 'text' : 'image'} multiple={type === 'list<image>'} onClose={() => setPicking(false)} onChoose={(elements) => { const refs = elements.map((e) => ({ elementId: e.id })); onChange(type === 'list<image>' ? refs : refs[0]); setPicking(false); }} />}
  </div>;
}
