import { useRef } from 'react';
import { outputType, downstreamClosure } from '../../../../shared/domain/workflow/contracts.js';
import { textDocument, parseTextDocument } from './workflowText.js';

export default function WorkflowTextField({ label, parts, nodes, selected, parent, onChange }) {
  const input = useRef(null), selection = useRef(null);
  const unavailable = downstreamClosure(nodes, [selected]);
  const choices = nodes.filter((n) => !unavailable.has(n.id) && outputType(n) === 'text').map((n) => ({ label: n.name || n.id, ref: { kind: 'output', nodeId: n.id, port: 'value', path: [] } }));
  if (parent?.config.itemsType === 'list<text>') choices.push({ label: '当前循环项', ref: { kind: 'item' } });
  for (const [key, type] of Object.entries(parent?.config.captureTypes || {})) if (type === 'text') choices.push({ label: `循环外：${parent.captureLabels?.[key] || key}`, ref: { kind: 'capture', name: key } });
  const name = (ref) => ref.kind === 'output' ? nodes.find((n) => n.id === ref.nodeId)?.name || ref.nodeId : ref.kind === 'capture' ? `循环外：${parent?.captureLabels?.[ref.name] || ref.name}` : ref.kind === 'item' ? '当前循环项' : ref.kind === 'itemId' ? '项 ID' : ref.kind === 'constant' ? String(ref.value) : '引用';
  const document = textDocument(parts, name);
  function insert(index) {
    const ref = choices[index].ref;
    const expanded = textDocument([...parts, { kind: 'ref', ref }], name);
    const token = expanded.references.find((r) => JSON.stringify(r.ref) === JSON.stringify(ref)).token;
    const [start, end] = selection.current || [document.text.length, document.text.length];
    const text = document.text.slice(0, start) + token + document.text.slice(end);
    onChange(parseTextDocument(text, expanded.references));
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(start + token.length, start + token.length); });
  }
  return <div className="workflow-content-field"><strong>{label}</strong><textarea ref={input} aria-label={label} rows={5} value={document.text} onSelect={(e) => { selection.current = [e.target.selectionStart, e.target.selectionEnd]; }} onChange={(e) => { selection.current = [e.target.selectionStart, e.target.selectionEnd]; onChange(parseTextDocument(e.target.value, document.references)); }} />
    <select aria-label={`${label}插入引用`} value="" disabled={!choices.length} onChange={(e) => insert(Number(e.target.value))}><option value="">插入引用…</option>{choices.map((choice, i) => <option key={i} value={i}>{choice.label}</option>)}</select>
    <small>{choices.length ? '引用插入到光标处，运行时替换为对应文字。' : '可以直接填写文字；添加其他文字来源后，可在这里插入引用。'}</small>
  </div>;
}
