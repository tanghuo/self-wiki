import { useRef } from 'react';
import { outputVariables, outputVariableName, downstreamClosure } from '../../../../shared/domain/workflow/contracts.js';
import { variableLabel, nodeDisplayName } from './workflowLabels.js';

import { editableTextParts } from './workflowText.js';

export default function WorkflowTextField({ label, parts, nodes, selected, parent, onChange, allowReferences = true }) {
  const inputs = useRef(new Map()), selection = useRef(null);
  const unavailable = downstreamClosure(nodes, [selected]);
  const choices = nodes.filter((n) => !unavailable.has(n.id)).flatMap((n) => outputVariables(n).filter((v) => v.type === 'text').map((v) => ({ label: `${nodeDisplayName(n)}${n.type === 'model' || v.path.length ? ' / ' + variableLabel(v) : ''}`, ref: { kind: 'output', nodeId: n.id, port: v.port, path: v.path } })));
  if (parent?.config.itemsType === 'list<text>') choices.push({ label: '这一项', ref: { kind: 'item' } });
  for (const [key, type] of Object.entries(parent?.config.captureTypes || {})) if (type === 'text') choices.push({ label: `循环外：${parent.captureLabels?.[key] || key}`, ref: { kind: 'capture', name: key } });
  const name = (ref) => {
    if (ref.kind === 'output') {
      const node = nodes.find((n) => n.id === ref.nodeId);
      return `${node ? nodeDisplayName(node) : '已删除的步骤'}${node && (node.type === 'model' || ref.path?.length) ? ' / ' + variableLabel(outputVariableName(node, ref)) : ''}`;
    }
    return ref.kind === 'capture' ? `循环外：${parent?.captureLabels?.[ref.name] || ref.name}` : ref.kind === 'item' ? '这一项' : ref.kind === 'itemId' ? '这一项的编号' : ref.kind === 'constant' ? String(ref.value) : '引用';
  };
  const segments = editableTextParts(parts), hasReferences = segments.length > 1;
  function insert(index) {
    const saved = selection.current;
    const at = saved && segments[saved.index]?.kind === 'text' ? saved.index : segments.length - 1;
    const text = segments[at].text;
    const input = saved?.index === at ? inputs.current.get(at) : null;
    const start = Math.min(input?.selectionStart ?? text.length, text.length);
    const end = Math.min(input?.selectionEnd ?? text.length, text.length);
    onChange([...segments.slice(0, at), { kind: 'text', text: text.slice(0, start) }, { kind: 'ref', ref: choices[index].ref }, { kind: 'text', text: text.slice(end) }, ...segments.slice(at + 1)]);
    selection.current = { index: at + 2, start: 0, end: 0 };
    requestAnimationFrame(() => { inputs.current.get(at + 2)?.focus(); inputs.current.get(at + 2)?.setSelectionRange(0, 0); });
  }
  return <div className="workflow-content-field workflow-text-field">
    <div className="workflow-text-toolbar"><strong>{label}</strong>
      {allowReferences && <select aria-label={`${label}插入引用`} value="" disabled={!choices.length} onChange={(e) => insert(Number(e.target.value))}><option value="">＋插入上游文字</option>{choices.map((choice, i) => <option key={i} value={i}>{choice.label}</option>)}</select>}
    </div>
    <div className={`workflow-text-composer ${hasReferences ? 'has-references' : ''}`}>
      {segments.map((part, index) => part.kind === 'text' ? <textarea key={`text:${index}`} ref={(input) => { if (input) inputs.current.set(index, input); else inputs.current.delete(index); }} aria-label={index === 0 ? label : `${label}补充文字 ${index / 2}`} placeholder={hasReferences ? index === 0 ? '在上游文字前添加…' : '在上游文字后添加…' : '输入文字…'} rows={hasReferences ? 2 : 5} value={part.text}
        onFocus={(e) => { selection.current = { index, start: e.target.selectionStart, end: e.target.selectionEnd }; }}
        onSelect={(e) => { selection.current = { index, start: e.target.selectionStart, end: e.target.selectionEnd }; }}
        onChange={(e) => onChange(segments.map((segment, i) => i === index ? { kind: 'text', text: e.target.value } : segment))} /> : <div key={`ref:${index}`} className="workflow-text-variable">
        <span aria-hidden="true">↳</span><select aria-label={`${label}文字来源 ${Math.ceil(index / 2)}`} value={choices.findIndex((choice) => JSON.stringify(choice.ref) === JSON.stringify(part.ref))} onChange={(e) => onChange(segments.map((segment, i) => i === index ? { kind: 'ref', ref: choices[Number(e.target.value)].ref } : segment))}>
          <option value={-1} disabled>{name(part.ref)}</option>{choices.map((choice, i) => <option value={i} key={i}>{choice.label}</option>)}
        </select><button type="button" aria-label={`断开 ${name(part.ref)}`} onClick={() => { selection.current = null; onChange(editableTextParts(segments.filter((_part, i) => i !== index))); }}>×</button>
      </div>)}
    </div>
  </div>;
}
