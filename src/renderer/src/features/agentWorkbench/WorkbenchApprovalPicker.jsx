import { ShieldCheck } from 'lucide-react';
import { approvalModes } from '../../../../shared/domain/agentWorkbench/approvalPolicy.js';

export default function WorkbenchApprovalPicker({ mode = 'ask', engine, disabled, onChange }) {
  return <label className="workbench-approval-picker" title={mode === 'allow' ? '自动允许范围内的文件修改和命令；命令使用当前用户权限运行' : '统一设置文件修改和命令执行的审批方式'}>
    <ShieldCheck size={14} />
    <select aria-label="审批模式" value={mode} disabled={disabled || engine !== 'grok-build'} onChange={event => onChange(event.target.value)}>
      {approvalModes.filter(value => engine === 'grok-build' || value.id === 'ask').map(value => <option key={value.id} value={value.id}>{value.label}</option>)}
    </select>
  </label>;
}
