import { useEffect, useState } from 'react';
import { request } from '../../api.js';
import WorkbenchApprovalPicker from './WorkbenchApprovalPicker.jsx';
import { rememberApprovalMode } from './workbenchApprovalMemory.js';

export default function WorkbenchPolicy({ session, busy, act, refresh }) {
  const [roots, setRoots] = useState((session.policy.readRoots || []).join('\n'));
  const [mode, setMode] = useState(session.policy.approvalMode || 'ask');
  useEffect(() => { setMode(session.policy.approvalMode || 'ask'); setRoots((session.policy.readRoots || []).join('\n')); }, [session.id, session.revision]);
  return <details className="workbench-task"><summary>会话权限与恢复</summary>
    {session.data.restricted || session.purpose === 'workflow' ? <p>此会话仅开放指定应用工具，不提供 Shell 或项目文件权限；工具集合不可扩大。内容建议与付费任务仍须用户处理。</p> : session.engine === 'codex-cli' ? <p>Codex 使用原生全盘读取权限、安全读取自动执行。写入和危险命令由原生只读权限及 untrusted 策略处理；本工作台只提供本次允许或拒绝，不创建长期规则。</p> : session.engine === 'antigravity-acp' ? <p>Antigravity 使用原生文件访问和手动审批；已有配置、插件和工具仍由 Antigravity 管理，工作目录不构成系统沙箱。审批仅本次有效，不限时等待。当前不注入 Wiki 或付费工作流工具，推理强度须由所选模型支持。</p> : <form className="workbench-create" onSubmit={event => { event.preventDefault(); act(async () => { const saved = await request(`/api/agent/sessions/${session.id}/policy`, { method: 'PUT', body: JSON.stringify({ revision: session.revision, approvalMode: mode, readRoots: roots.split(/\r?\n/).map(value => value.trim()).filter(Boolean) }) }); rememberApprovalMode(saved.engine, saved.policy?.approvalMode); await refresh(); }); }}>
      <WorkbenchApprovalPicker mode={mode} engine={session.engine} disabled={busy || session.state === 'running'} onChange={setMode} />
      <label>额外只读目录（每行一个）<textarea value={roots} onChange={event => setRoots(event.target.value)} rows={2} /></label>
      <p className="workbench-muted">权限变化会使旧审批失效。自动模式由 Grok 评估，仍需确认时在此审批；全部允许会自动执行范围内的修改和命令。命令使用当前用户权限运行。</p>
      <button disabled={busy || session.state === 'running'}>保存会话权限</button>
    </form>}
    {session.engineSessionId && <button disabled={busy || session.state === 'running'} onClick={() => act(async () => { await request(`/api/agent/sessions/${session.id}/resume`, { method: 'POST', body: '{}' }); await refresh(); })}>检查并恢复原上下文</button>}
    <p className="workbench-muted">恢复只加载上下文，不会发送任务。不可恢复时可通过“新建会话”明确开始新的上下文。</p>
  </details>;
}
