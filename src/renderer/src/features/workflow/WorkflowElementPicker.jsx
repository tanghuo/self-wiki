import { useEffect, useState } from 'react';
import Dialog from '../../Dialog.jsx';
import { apiUrl, request } from '../../api.js';

export default function WorkflowElementPicker({ kind, multiple, onChoose, onClose }) {
  const [q, setQ] = useState(''), [page, setPage] = useState(1), [data, setData] = useState(null), [selected, setSelected] = useState([]), [error, setError] = useState('');
  const [preview, setPreview] = useState(null), [detail, setDetail] = useState(null), [previewError, setPreviewError] = useState('');
  useEffect(() => {
    let alive = true;
    request(`/api/elements?${new URLSearchParams({ kind, q, page, pageSize: 24 })}`).then((value) => { if (alive) { setData(value); setError(''); } }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [kind, q, page]);
  useEffect(() => {
    setDetail(null); setPreviewError('');
    if (!preview) return;
    let alive = true;
    request(`/api/elements/${preview.id}`).then((element) => { if (alive) setDetail(element); }).catch((e) => { if (alive) setPreviewError(e.message); });
    return () => { alive = false; };
  }, [preview?.id]);
  function toggle(element) { setSelected((all) => all.some((e) => e.id === element.id) ? all.filter((e) => e.id !== element.id) : multiple ? [...all, element].slice(0, 1000) : [element]); }
  function inspect(element) {
    setPreview(element);
    if (multiple) toggle(element);
    else setSelected([element]);
  }
  return <Dialog open label="选择工作流素材" className="wiki-dialog workflow-picker" onClose={onClose}>
    <header className="wiki-dialog-header"><h2>选择{kind === 'image' ? '图片' : '文字'}素材</h2><button onClick={onClose} aria-label="关闭素材选择">关闭</button></header>
    <div className="workflow-picker-body">
      <label className="workflow-picker-search">搜索素材<input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></label>
      <p className="workflow-picker-hint">{kind === 'text' ? '点击素材查看全文，确认内容后再使用。' : '点击图片查看大图并选择，可跨页多选。'}</p>
      {error && <p role="alert" className="workflow-error">{error}</p>}
      <div className="workflow-picker-browser">
        <section className="workflow-picker-results" aria-label="素材列表">
          <div className={kind === 'text' ? 'workflow-picker-text-list' : 'workflow-picker-grid'}>{data?.elements.map((element) => <button key={element.id} aria-label={`预览素材 #${element.id}`} aria-pressed={selected.some((e) => e.id === element.id)} data-preview={preview?.id === element.id} onClick={() => inspect(element)}>
            {kind === 'image' ? <img src={apiUrl(`/api/elements/${element.id}/thumbnail?width=400`)} alt={element.image?.originalName || `图片 #${element.id}`} /> : <span>{element.body || '（空白文字）'}</span>}
            <small>#{element.id}{kind === 'text' ? ` · ${(element.body || '').length} 字` : ` ${element.image?.originalName || ''}`}{selected.some((e) => e.id === element.id) ? ' · 已选' : ''}</small>
          </button>)}</div>
          {data && !data.elements.length && <p className="workflow-picker-hint">没有找到匹配的素材。</p>}
          <div className="workflow-actions workflow-picker-pagination"><button disabled={page <= 1} onClick={() => setPage((v) => v - 1)}>上一页</button><span>第 {page} 页</span><button disabled={!data?.elements.length || data.elements.length < 24} onClick={() => setPage((v) => v + 1)}>下一页</button></div>
        </section>
        <section className="workflow-picker-preview" aria-label={kind === 'text' ? '文字全文预览' : '图片大图预览'}>
          {preview ? <><header><strong>#{preview.id}{kind === 'text' ? ' · 文字全文' : ` · ${detail?.image?.originalName || preview.image?.originalName || '图片'}`}</strong>{kind === 'image' && <a href={apiUrl(`/api/elements/${preview.id}/image`)} target="_blank" rel="noreferrer">查看原图 ↗</a>}</header>
            {previewError ? <p role="alert" className="workflow-error">{previewError}</p> : !detail ? <p role="status">正在读取完整内容…</p> : kind === 'text' ? <><small className="workflow-picker-hint">共 {(detail.body || '').length} 字</small><pre className="workflow-picker-full-text">{detail.body || '（空白文字）'}</pre></> : <img className="workflow-picker-large-image" src={apiUrl(`/api/elements/${preview.id}/image`)} alt={detail.image?.originalName || `图片 #${preview.id} 大图`} />}
          </> : <div className="workflow-picker-preview-empty">{kind === 'text' ? '选择左侧文字，在这里阅读完整内容' : '选择左侧图片，在这里查看大图'}</div>}
        </section>
      </div>
      {multiple && selected.length > 0 && <details className="workflow-picker-selection"><summary>已选顺序（{selected.length}）</summary><ol>{selected.map((element, index) => <li key={element.id}><button className="workflow-picker-selected-name" onClick={() => setPreview(element)}>#{element.id} {element.image?.originalName || element.body?.slice(0, 60)}</button><button disabled={!index} onClick={() => setSelected((items) => { const next = [...items]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}>上移</button><button onClick={() => toggle(element)}>移除</button></li>)}</ol></details>}
    </div>
    <footer className="wiki-dialog-footer"><span>{selected.length ? multiple ? `已选 ${selected.length} 项` : `已选 #${selected[0].id}` : '尚未选择素材'}</span><button disabled={!selected.length} onClick={() => onChoose(selected)}>使用选中素材</button></footer>
  </Dialog>;
}
