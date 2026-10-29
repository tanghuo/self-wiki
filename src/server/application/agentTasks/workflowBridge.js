// The workflow repository owns every run transition. This observer only links
// the approved task to that run and publishes bounded previews of its results.
export function createWorkflowTaskBridge({ repo, workflow, store }) {
  const watching = new Map(); let closed = false, ticking = false;
  const terminal = new Set(['succeeded', 'partial_failed', 'failed', 'cancelled']);
  async function results(run) {
    const artifacts = [], seen = new Set(), lines = [`# ${workflow.get(run.workflowId).name}`, `工作流运行 #${run.id} 已完成。以下为预览摘要，完整内容保留在原运行。`];
    let omitted = 0;
    async function visit(id, label, depth = 0) {
      if (seen.has(id) || depth > 32 || seen.size >= 2000) return; seen.add(id);
      const a = await workflow.artifact(id, run.id);
      if (a.type === 'image') {
        if (artifacts.length < 64) artifacts.push({ type: 'image', storageKey: `workflow:${run.id}:${a.id}`, hash: a.hash, byteSize: a.byteSize, mimeType: a.metadata.mime, producer: 'workflow-ref', metadata: { ...a.metadata, sourceRunId: run.id, sourceArtifactId: a.id } });
        else omitted++;
      } else {
        const text = typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
        lines.push(`\n## ${label}\n${(text || '').slice(0, 8000)}${text?.length > 8000 ? '\n（预览已截取）' : ''}`);
        async function refs(value, level = 0) {
          if (!value || typeof value !== 'object' || level > 32) return;
          if (typeof value.artifactId === 'string') await visit(value.artifactId, label, depth + 1);
          else if (Array.isArray(value)) { for (const item of value.slice(0, 2000)) await refs(item, level + 1); }
          else for (const item of Object.values(value).slice(0, 2000)) await refs(item, level + 1);
        }
        await refs(a.value);
      }
    }
    for (const [index, node] of run.definition.nodes.entries()) {
      const instance = run.rootInstances.find(instance => instance.nodeId === node.id);
      for (const id of new Set(Object.values(instance?.outputs || {}))) await visit(id, `第 ${index + 1} 步 · ${node.name || node.id}`);
    }
    if (omitted) lines.push(`\n还有 ${omitted} 张图片，请在原工作流运行中查看。`);
    const text = lines.join('\n'), preview = text.length > 11000 ? `${text.slice(0, 11000)}\n（摘要已截取；完整结果请查看原工作流运行 #${run.id}。）` : text;
    artifacts.unshift(await store.saveText(preview, { sourceRunId: run.id, summary: true, truncated: text.length > 11000, originalCharacters: text.length, imagePreviewLimit: 64, omittedImages: omitted }));
    return artifacts;
  }
  async function inspect(id) {
    const task = repo.task(id), binding = repo.workflowBinding(task.id, task.attemptId);
    if (!binding) throw new Error('没有已确认的工作流运行；不能安全重新提交，请明确重新执行');
    let run = workflow.run(binding.runId);
    if (task.cancelRequested && !terminal.has(run.state)) {
      try { workflow.control(run.id, { action: 'cancel', controlVersion: run.controlVersion, requestKey: `agent-cancel-${task.id}-${task.attemptId}` }); }
      catch (error) { if (error.statusCode !== 409) throw error; }
      run = workflow.run(run.id);
    }
    if (run.state === 'succeeded') return repo.finish(task.id, task.attemptId, 'succeeded', { saved: true, inWiki: false, workflowState: run.state, progress: '工作流已完成，结果摘要已保存' }, await results(run));
    if (terminal.has(run.state)) return repo.finish(task.id, task.attemptId, run.state === 'cancelled' ? 'cancelled' : 'failed', { workflowState: run.state, error: `原工作流状态：${run.state}；已产生的结果保留在原运行` });
    if (run.state === 'needs_attention') return repo.finish(task.id, task.attemptId, 'unknown', { workflowState: run.state, error: '工作流存在未知尝试，请到原运行核查；不会重新提交' });
    if (task.data.workflowState !== run.state) return repo.progress(task.id, task.attemptId, { workflowState: run.state, progress: run.state === 'waiting_review' ? '工作流等待人工审核，请打开原运行处理' : '工作流正在执行' });
    return task;
  }
  async function tick() {
    if (closed || ticking) return; ticking = true;
    try {
      for (const id of watching.keys()) {
        try { const task = await inspect(id); if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(task.state)) watching.delete(id); }
        catch (error) { const task = repo.task(id); repo.finish(id, task.attemptId, 'unknown', { error: error.message, saved: false }); watching.delete(id); }
      }
    } finally { ticking = false; }
  }
  const timer = setInterval(() => { void tick(); }, 500); timer.unref();
  return {
    async start(task, operation, signal) {
      signal.throwIfAborted(); repo.dispatch(task.id, task.attemptId);
      const run = workflow.startAgentRun(operation.executor.snapshot, `agent-run-${task.id}-${task.attemptId}`, run => repo.bindWorkflow(task.id, task.attemptId, run, operation.input.callChain));
      watching.set(task.id, run.id); void tick();
    },
    async reconcile(task) { const result = await inspect(task.id); if (!terminal.has(result.state) && result.state !== 'unknown') watching.set(task.id, result.data.workflowRunId); return result; },
    cancel(task) { if (task.attemptId && repo.workflowBinding(task.id, task.attemptId)) { watching.set(task.id, task.data.workflowRunId); void tick(); } },
    hasActive: () => watching.size > 0 || repo.activeWorkflowRuns(),
    async close() { closed = true; clearInterval(timer); while (ticking) await new Promise(resolve => setTimeout(resolve, 10)); watching.clear(); },
  };
}
