import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

const efforts = { low: '低', medium: '中', high: '高', xhigh: '极高' };

export default function WorkbenchModelPicker({ engine, model, effort, engines, models, modelState, retryModels, busy, change, selectEngine, loadModels, connectAntigravity }) {
  const [panel, setPanel] = useState(null), [position, setPosition] = useState({}), [custom, setCustom] = useState('');
  const root = useRef(null), popup = useRef(null), trigger = useRef(null);
  const options = models.some(value => value.id === model) || !model ? models : [{ id: model, label: model }, ...models];
  function close(focus = false) { setPanel(null); if (focus) trigger.current?.focus(); }
  function open(event, next) {
    if (panel === next) { close(); return; }
    trigger.current = event.currentTarget;
    const rect = event.currentTarget.getBoundingClientRect();
    setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - 312)), bottom: window.innerHeight - rect.top + 8, maxHeight: Math.max(100, rect.top - 20) });
    setPanel(next);
    if (next === 'models') loadModels();
  }
  useEffect(() => {
    if (!panel) return;
    (popup.current?.querySelector('button[aria-pressed="true"]:not(:disabled), button:not(:disabled)') || popup.current)?.focus();
    const outside = event => { if (!root.current?.contains(event.target)) close(); };
    const resize = () => close();
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', resize);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize); };
  }, [panel]);
  return <div className="workbench-model-control" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    if (panel && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && event.target.tagName === 'BUTTON') {
      const buttons = [...popup.current.querySelectorAll('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement);
      event.preventDefault();
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
  }}>
    <button type="button" className="workbench-config-trigger" aria-label="选择模型与推理强度" aria-haspopup="dialog" aria-expanded={panel === 'models'} disabled={busy} onClick={event => open(event, 'models')}><span>{options.find(value => value.id === model)?.label || model || '选择模型'}</span><ChevronDown size={13} /></button>
    <button type="button" className="workbench-config-trigger" aria-label="选择推理强度" aria-haspopup="dialog" aria-expanded={panel === 'effort'} disabled={busy} onClick={event => open(event, 'effort')}>{efforts[effort] || effort}<ChevronDown size={13} /></button>
    {panel && <div ref={popup} tabIndex={-1} className="workbench-model-popover" style={position} role="dialog" aria-label={panel === 'models' ? '选择模型' : '推理强度'}>
      <header>{panel === 'models' ? '选择模型' : '推理强度'}</header>
      {panel === 'models' ? <>
        {selectEngine && <div className="workbench-engine-options" role="group" aria-label="执行引擎">{engines.map(value => <button type="button" key={value.id} aria-pressed={engine === value.id} disabled={busy} onClick={() => selectEngine(value.id)}>{value.label}</button>)}</div>}
        {engine === 'antigravity-acp' && modelState?.authRequired && connectAntigravity && <><button type="button" disabled={busy || modelState.loading} onClick={connectAntigravity}>连接 Antigravity 账号</button><p className="workbench-muted">登录已失效或尚未授权，请连接账号并在浏览器中完成授权。</p></>}
        <div role="group" aria-label="模型列表">{options.map(value => <button className="workbench-model-option" type="button" key={value.id} aria-pressed={model === value.id} disabled={busy} onClick={() => { change({ model: value.id }); close(true); }}><span>{value.label || value.id}</span>{model === value.id && <Check size={17} />}</button>)}</div>
        {modelState?.loading && <p role="status">{modelState.connecting ? '正在连接账号，请在浏览器中完成授权…' : '正在读取模型…'}</p>}
        {modelState?.error && <div><p role="alert">{modelState.error}</p><button type="button" disabled={busy} onClick={retryModels}>重试读取模型</button></div>}
        <details className="workbench-custom-model"><summary>自定义模型</summary><div><input aria-label="自定义模型" placeholder="输入模型 ID" value={custom} onChange={event => setCustom(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (custom.trim() && !busy) { change({ model: custom.trim() }); close(true); } } }} /><button type="button" disabled={busy || !custom.trim()} onClick={() => { change({ model: custom.trim() }); close(true); }}>使用</button></div></details>
      </> : Object.entries(efforts).filter(([value]) => engine !== 'antigravity-acp' || value !== 'xhigh').map(([value, label]) => <button className="workbench-model-option" type="button" key={value} aria-pressed={effort === value} disabled={busy} onClick={() => { change({ effort: value }); close(true); }}><span>{label}</span>{effort === value && <Check size={17} />}</button>)}
    </div>}
  </div>;
}
