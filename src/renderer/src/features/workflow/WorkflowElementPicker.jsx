import { useEffect, useState } from 'react';
import Dialog from '../../Dialog.jsx';
import { apiUrl, request } from '../../api.js';

export default function WorkflowElementPicker({ kind, multiple, onChoose, onClose }) {
  const [q, setQ] = useState(''), [page, setPage] = useState(1), [data, setData] = useState(null), [selected, setSelected] = useState([]), [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    request(`/api/elements?${new URLSearchParams({ kind, q, page, pageSize: 24 })}`).then((value) => { if (alive) { setData(value); setError(''); } }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [kind, q, page]);
  function toggle(element) { setSelected((all) => all.some((e) => e.id === element.id) ? all.filter((e) => e.id !== element.id) : multiple ? [...all, element].slice(0, 1000) : [element]); }
  return <Dialog open label="选择工作流素材" className="wiki-dialog workflow-picker" onClose={onClose}><header className="wiki-dialog-header"><h2>选择{kind === 'image' ? '图片' : '文字'}素材</h2><button onClick={onClose} aria-label="关闭素材选择">关闭</button></header><div className="workflow-picker-body"><label>搜索素材<input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></label><p>跨页选择，输入顺序按下方已选列表固定。运行开始前会保存独立快照。</p>{error && <p role="alert">{error}</p>}<div className="workflow-picker-grid">{data?.elements.map((element) => <button key={element.id} aria-pressed={selected.some((e) => e.id === element.id)} onClick={() => toggle(element)}>{kind === 'image' ? <img src={apiUrl(`/api/elements/${element.id}/thumbnail?width=400`)} alt="" /> : <span>{element.body?.slice(0, 200)}</span>}<small>#{element.id} {element.image?.originalName || ''}</small></button>)}</div><div className="workflow-actions"><button disabled={page <= 1} onClick={() => setPage((v) => v - 1)}>上一页</button><span>第 {page} 页</span><button disabled={!data?.elements.length || data.elements.length < 24} onClick={() => setPage((v) => v + 1)}>下一页</button></div><h3>已选顺序（{selected.length}）</h3><ol>{selected.map((element, index) => <li key={element.id}>#{element.id} {element.image?.originalName || element.body?.slice(0, 50)}<button disabled={!index} onClick={() => setSelected((items) => { const next = [...items]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}>上移</button><button onClick={() => toggle(element)}>移除</button></li>)}</ol></div><footer className="wiki-dialog-footer"><button disabled={!selected.length} onClick={() => onChoose(selected)}>使用选中素材</button></footer></Dialog>;
}
