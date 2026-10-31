import { useEffect, useRef, useState } from 'react';
import { Check, Hand, ShieldCheck, TriangleAlert } from 'lucide-react';
import { approvalModes } from '../../../../shared/domain/agentWorkbench/approvalPolicy.js';

const icons = { ask: Hand, auto: ShieldCheck, allow: TriangleAlert };
const descriptions = {
  ask: '修改文件或运行命令时始终询问',
  auto: '仅对 Grok 判定为风险的操作请求批准',
  allow: '自动执行范围内的文件修改和命令',
};

export default function WorkbenchApprovalPicker({ mode = 'ask', engine, disabled, onChange }) {
  const [open, setOpen] = useState(false), [position, setPosition] = useState({});
  const root = useRef(null), popup = useRef(null), trigger = useRef(null);
  const current = approvalModes.find(value => value.id === mode) || approvalModes[0];
  const Icon = icons[current.id] || ShieldCheck;
  const locked = disabled || engine !== 'grok-build';
  const options = approvalModes.filter(value => engine === 'grok-build' || value.id === 'ask');
  function close(focus = false) { setOpen(false); if (focus) trigger.current?.focus(); }
  function show(event) {
    if (locked) return;
    if (open) { close(); return; }
    trigger.current = event.currentTarget;
    const rect = event.currentTarget.getBoundingClientRect();
    const above = rect.top >= window.innerHeight - rect.bottom;
    setPosition({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - 372)),
      ...(above ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }),
      maxHeight: Math.max(0, (above ? rect.top : window.innerHeight - rect.bottom) - 20),
    });
    setOpen(true);
  }
  useEffect(() => {
    if (!open) return;
    (popup.current?.querySelector('button[aria-pressed="true"]') || popup.current)?.focus();
    const outside = event => { if (!root.current?.contains(event.target)) close(); };
    const resize = () => close();
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', resize);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize); };
  }, [open]);
  return <div className="workbench-approval-picker" ref={root} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true); }
    if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const buttons = [...popup.current.querySelectorAll('.workbench-approval-option')];
      const index = buttons.indexOf(document.activeElement);
      event.preventDefault();
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
  }}>
    <button type="button" ref={trigger} className="workbench-approval-trigger" data-mode={current.id} aria-label="审批模式" aria-haspopup="dialog" aria-expanded={open} disabled={locked} title={descriptions[current.id]} onClick={show}>
      <Icon size={15} /><span>{current.label}</span>
    </button>
    {open && <div ref={popup} tabIndex={-1} className="workbench-approval-popover" style={position} role="dialog" aria-label="选择审批模式">
      <header>应如何批准这些操作？</header>
      {options.map(value => {
        const OptionIcon = icons[value.id];
        return <button type="button" className="workbench-approval-option" data-mode={value.id} key={value.id} aria-label={value.label} aria-pressed={mode === value.id} onClick={() => { if (value.id !== mode) onChange(value.id); close(true); }}>
          <OptionIcon size={18} />
          <span><strong>{value.label}</strong><small>{descriptions[value.id]}</small></span>
          {mode === value.id ? <Check size={16} /> : <span className="workbench-approval-check" aria-hidden="true" />}
        </button>;
      })}
    </div>}
  </div>;
}
