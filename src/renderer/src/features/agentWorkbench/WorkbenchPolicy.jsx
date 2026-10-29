import { useState } from 'react';
import { request } from '../../api.js';

export default function WorkbenchPolicy({ session, busy, act, refresh }) {
  const [write, setWrite] = useState(session.policy.write), [roots, setRoots] = useState((session.policy.readRoots || []).join('\n'));
  return <details className="workbench-task"><summary>会话权限与恢复</summary>
    {session.data.restricted || session.purpose === 'workflow' ? <p>此会话仅开放指定应用工具，不提供 Shell 或项目文件权限；工具集合不可扩大。Wiki 建议与付费任务仍须用户处理。</p> : session.engine === 'codex-cli' ? <p>Codex 使用原生全盘读取权限、安全读取自动执行。写入和危险命令由原生只读权限及 untrusted 策略处理；本工作台只提供本次允许或拒绝，不创建长期规则。</p> : <form className="workbench-create" onSubmit={event => { event.preventDefault(); act(async () => { await request(`/api/agent/sessions/${session.id}/policy`, { method: 'PUT', body: JSON.stringify({ revision: session.revision, write, readRoots: roots.split(/\r?\n/).map(value => value.trim()).filter(Boolean) }) }); await refresh(); }); }}>
      <label>文件写入<select value={write} onChange={event => setWrite(event.target.value)}><option value="ask">每次修改都审批</option><option value="allow_workspace">允许此会话写入工作区</option></select></label>
      <label>额外只读目录（每行一个）<textarea value={roots} onChange={event => setRoots(event.target.value)} rows={2} /></label>
      <p className="workbench-muted">权限变化会使旧审批失效。命令仍逐次审批，并使用当前用户权限运行。</p>
      <button disabled={busy || session.state === 'running'}>保存会话权限</button>
    </form>}
    {session.engineSessionId && <button disabled={busy || session.state === 'running'} onClick={() => act(async () => { await request(`/api/agent/sessions/${session.id}/resume`, { method: 'POST', body: '{}' }); await refresh(); })}>检查并恢复原上下文</button>}
    <p className="workbench-muted">恢复只加载上下文，不会发送任务。不可恢复时可通过“新建会话”明确开始新的上下文。</p>
  </details>;
}
