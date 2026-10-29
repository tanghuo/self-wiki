import { grokBuildImageExecutor, recoverGrokBuildImage } from '../executorsPort.js';
import { grokBuildConfig, grokAspectRatios } from '../../../shared/domain/imageGeneration.js';
import { agentError, requestKey } from '../../../shared/domain/agentWorkbench/contracts.js';
import { workflowCallChain } from '../../../shared/domain/agentWorkbench/workflow.js';
import { outputType, isRuntimeElement } from '../../../shared/domain/workflow/contracts.js';
import { createWorkflowTaskBridge } from './workflowBridge.js';

export function createAgentTaskService({ repo, sessions, store, wiki, workflow, executionConfig, enabled = () => true, imageExecutor = grokBuildImageExecutor }) {
  const thisContent = async (id, sessionId) => { const artifact = repo.artifact(Number(id), Number(sessionId)); return { artifact, bytes: artifact.producer === 'workflow-ref' ? (await workflow.artifact(artifact.metadata.sourceArtifactId, artifact.metadata.sourceRunId, true)).bytes : await store.read(artifact) }; };
  const active = new Map(); let closing = false;
  repo.recover();
  const workflowBridge = workflow && createWorkflowTaskBridge({ repo, workflow, store });
  const expiryTimer = setInterval(() => repo.expire(), 30000); expiryTimer.unref();
  function owner(taskId, sessionId) { const task = repo.task(Number(taskId)); if (task.sessionId !== Number(sessionId)) throw agentError('TASK_DENIED', '任务不属于此会话', 404); return task; }
  async function run(task) {
    const controller = new AbortController(); active.set(task.id, { controller });
    let attempt;
    try {
      task = repo.start(task.id); attempt = task.attemptId;
      const op = repo.taskOperation(task.id);
      if (task.executor.id === 'workflow') { await workflowBridge.start(task, op, controller.signal); return; }
      const directory = await store.attemptDirectory(attempt);
      const references = [];
      for (const id of op.input.referenceArtifactIds) references.push(await store.materializeBytes((await thisContent(id, task.sessionId)).bytes, directory));
      const result = await imageExecutor.generate({ prompt: op.input.prompt, referencePaths: references, aspectRatio: op.input.aspectRatio }, {
        config: task.executor.settings, workspace: directory, signal: controller.signal,
        onDispatch(metadata) {
          controller.signal.throwIfAborted(); repo.dispatch(task.id, attempt);
          if (metadata) repo.progress(task.id, attempt, { metadata: { grokBuild: metadata }, remoteId: metadata.sessionId });
        },
        onProgress(value) {
          const data = value.type === 'metadata' ? { metadata: value.metadata, ...(value.metadata?.grokBuild?.sessionId && { remoteId: value.metadata.grokBuild.sessionId }) } : { progress: String(value.message || '').slice(0, 1000) };
          repo.progress(task.id, attempt, data);
        },
      });
      // A real completion wins a cancellation race. Save before setting succeeded.
      const retrieval = await store.stageResult(attempt, result.bytes); repo.progress(task.id, attempt, { retrieval });
      const artifact = await store.saveImage(result.bytes, { operationId: op.id });
      repo.finish(task.id, attempt, 'succeeded', { saved: true, inWiki: false }, [artifact]);
    } catch (error) {
      if (attempt) {
        const actual = repo.task(task.id);
        const dispatched = actual.state === 'running' || actual.state === 'unknown';
        repo.finish(task.id, attempt, dispatched ? 'unknown' : controller.signal.aborted ? 'cancelled' : 'failed', { error: error.message, code: error.code || 'TASK_ERROR', saved: false });
      }
    } finally { active.delete(task.id); }
  }
  function schedule() {
    if (closing || !enabled()) return;
    for (const task of repo.queued()) if (!active.has(task.id) && active.size < 2) {
      // A worker may wait inside the shared adapter resource gate; dispatch stays
      // false until the adapter's onDispatch callback, immediately before spawn.
      const promise = run(task); const job = active.get(task.id); if (job) job.promise = promise;
      void promise.finally(() => schedule()).catch(() => {});
    }
  }
  return {
    schedule,
    hasActive: () => active.size > 0 || repo.queued().length > 0 || !!workflowBridge?.hasActive(),
    workflowChain: runId => repo.workflowChain(Number(runId)),
    workflowList: () => workflow.list().filter(value => !value.archivedAt),
    workflowRead: id => workflow.get(Number(id)),
    async submitWorkflow(sessionId, turnId, value, assertLive = () => {}) {
      if (!enabled() || closing || !workflow) throw agentError('WORKBENCH_DISABLED', '工作流工作台尚未启用', 409);
      sessionId = Number(sessionId); turnId = Number(turnId);
      if (sessions.turn(turnId).sessionId !== sessionId) throw agentError('OWNER_MISMATCH', '轮次不属于此会话', 403);
      if (value.operationId !== undefined && !/^[a-f0-9-]{36}$/.test(value.operationId)) throw agentError('INVALID_OPERATION', '无效操作标识');
      const submission = structuredClone({ workflowId: value.workflowId, revision: value.revision, inputs: value.inputs || {} });
      if (!Number.isSafeInteger(submission.workflowId) || !Number.isSafeInteger(submission.revision) || JSON.stringify(submission).length > 128000) throw agentError('INVALID_WORKFLOW_INPUT', '工作流标识、版本或输入无效');
      const previous = value.operationId && repo.findOperation(value.operationId);
      if (previous) { if (previous.sessionId !== sessionId || previous.kind !== 'workflow.submit' || JSON.stringify(previous.input.submission) !== JSON.stringify(submission)) throw agentError('STATE_CONFLICT', '同一操作标识对应不同工作流输入', 409); return previous; }
      const parent = sessions.session(sessionId).data.callChain || {};
      const callChain = workflowCallChain(parent, submission.workflowId, parent.parentTaskId);
      const inputs = structuredClone(submission.inputs), definition = workflow.get(submission.workflowId).definition;
      async function image(ref) {
        if (ref && Object.keys(ref).length === 1 && Number.isSafeInteger(ref.agentArtifactId)) {
          const source = await this.content(ref.agentArtifactId, sessionId);
          if (source.artifact.type !== 'image') throw agentError('INVALID_REFERENCES', '工作流图片输入必须引用图片');
          return workflow.addInputImage(source.bytes, 'agent-reference.png');
        }
        return ref;
      }
      for (const node of definition.nodes.filter(isRuntimeElement)) if (Object.hasOwn(inputs, node.config.parameter)) {
        const type = outputType(node), value = inputs[node.config.parameter];
        if (type === 'image') inputs[node.config.parameter] = await image.call(this, value);
        else if (type === 'list<image>' && Array.isArray(value)) { const refs = []; for (const ref of value) refs.push(await image.call(this, ref)); inputs[node.config.parameter] = refs; }
      }
      const snapshot = await workflow.freezeAgentRun(submission.workflowId, submission.revision, inputs);
      assertLive();
      return repo.submit({ operationId: value.operationId, sessionId, turnId, kind: 'workflow.submit', input: { submission, callChain, name: snapshot.name, maxCalls: snapshot.maxCalls, steps: snapshot.definition.nodes.map(node => ({ name: node.name || node.id, type: node.type })) }, executor: { id: 'workflow', snapshot } });
    },
    operations: sessionId => repo.operations(Number(sessionId)),
    list: sessionId => repo.list(Number(sessionId)),
    get: (id, sessionId) => owner(id, sessionId),
    operation(id, sessionId) { const value = repo.operation(id); if (value.sessionId !== Number(sessionId)) throw agentError('OPERATION_DENIED', '付费操作不属于此会话', 404); return value; },
    submit(sessionId, turnId, value) {
      if (!enabled() || closing) throw agentError('WORKBENCH_DISABLED', '工作台已停用', 409);
      const turn = sessions.turn(Number(turnId));
      if (turn.sessionId !== Number(sessionId)) throw agentError('OWNER_MISMATCH', '轮次不属于此会话', 403);
      if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 12000 || value.executor && value.executor !== 'grok-build') throw agentError('INVALID_IMAGE_REQUEST', '请输入有效图片需求，目前支持 Grok Build 独立任务');
      if (value.operationId !== undefined && (typeof value.operationId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.operationId))) throw agentError('INVALID_OPERATION', '无效的 operationId');
      const referenceArtifactIds = value.referenceArtifactIds || [];
      if (!Array.isArray(referenceArtifactIds) || referenceArtifactIds.length > 8) throw agentError('INVALID_REFERENCES', '参考图最多 8 张');
      for (const id of referenceArtifactIds) if (repo.artifact(id, Number(sessionId)).type !== 'image') throw agentError('INVALID_REFERENCES', '参考产物必须是图片');
      const aspectRatio = value.aspectRatio || executionConfig().imageGeneration?.grokBuild?.aspectRatio || 'auto';
      if (!grokAspectRatios.includes(aspectRatio)) throw agentError('INVALID_RATIO', '不支持的图片比例');
      const settings = grokBuildConfig(executionConfig().imageGeneration?.grokBuild || { executable: 'grok', model: 'grok-4.6', aspectRatio: 'auto' });
      return repo.submit({ operationId: value.operationId, sessionId: Number(sessionId), turnId: Number(turnId), kind: referenceArtifactIds.length ? 'image.edit' : 'image.generate', input: { prompt: value.prompt, referenceArtifactIds, aspectRatio }, executor: { id: 'grok-build', settings } });
    },
    decide(id, sessionId, value) { this.operation(id, sessionId); requestKey(value.requestKey); const result = repo.decide(id, value); schedule(); return result; },
    cancel(id, sessionId, value) { const task = owner(id, sessionId); requestKey(value.requestKey); const result = repo.cancel(task.id, value.revision); active.get(task.id)?.controller.abort(); if (task.executor.id === 'workflow') workflowBridge.cancel(result); return result; },
    expireTurn(turnId) { repo.expireTurn(Number(turnId)); },
    async reconcile(id, sessionId, value) {
      requestKey(value.requestKey); const task = owner(id, sessionId);
      if (task.state === 'succeeded') return task;
      if (task.state !== 'unknown' || !task.attemptId || active.has(task.id)) throw agentError('STATE_CONFLICT', '任务未停止或不处于待核查状态', 409);
      if (task.executor.id === 'workflow') return workflowBridge.reconcile(task);
      let bytes;
      try { bytes = await store.stagedResult(task.attemptId, task.data.retrieval); }
      catch (error) {
        if (error.code !== 'ENOENT' || !task.data.metadata?.grokBuildOutput) throw error;
        bytes = await recoverGrokBuildImage(task.data.metadata.grokBuildOutput);
      }
      const artifact = await store.saveImage(bytes, { reconciled: true });
      return repo.finish(task.id, task.attemptId, 'succeeded', { saved: true, reconciled: true, inWiki: false }, [artifact]);
    },
    reexecute(id, sessionId, value) {
      requestKey(value.requestKey); const task = owner(id, sessionId);
      if (!/^[a-f0-9-]{36}$/.test(value.operationId || '')) throw agentError('INVALID_OPERATION', '重试需要新的操作标识');
      const previous = repo.findOperation(value.operationId);
      if (previous) {
        if (previous.sessionId !== task.sessionId || previous.kind !== 'task.retry' || previous.input.taskId !== task.id || previous.input.revision !== value.revision) throw agentError('STATE_CONFLICT', '重试标识对应不同操作', 409);
        return previous;
      }
      if (task.revision !== value.revision || !['unknown', 'failed', 'cancelled'].includes(task.state) || active.has(task.id)) throw agentError('STATE_CONFLICT', '任务状态已变化或仍在执行', 409);
      return repo.submit({ operationId: value.operationId, sessionId: task.sessionId, turnId: task.turnId, kind: 'task.retry', input: { ...repo.taskOperation(task.id).input, taskId: task.id, revision: task.revision }, executor: task.executor });
    },
    artifact: (id, sessionId) => repo.artifact(Number(id), Number(sessionId)),
    artifacts: id => repo.artifacts(Number(id)),
    async saveToWiki(id, sessionId) {
      const artifact = repo.artifact(Number(id), Number(sessionId)), receipt = repo.wikiReceipt(artifact.id);
      if (receipt) return receipt;
      const { bytes } = await this.content(artifact.id, sessionId);
      const element = artifact.type === 'text' ? await wiki.create({ body: bytes.toString('utf8'), tags: [] }) : await wiki.importImage(bytes, `Agent-${artifact.hash.slice(0, 12)}.png`, []);
      return repo.saveWikiReceipt(artifact.id, element.id);
    },
    async upload(id, bytes) {
      if (!enabled() || closing) throw agentError('WORKBENCH_DISABLED', '工作台已停用', 409);
      sessions.session(Number(id)); return repo.publishArtifact(Number(id), await store.saveImage(bytes, { source: 'user' }));
    },
    prepareUpload: bytes => store.saveImage(bytes, { source: 'legacy-chat' }),
    publishUpload: (id, value) => repo.publishArtifact(id, value),
    async modelImage(id, sessionId) { const value = await this.content(id, sessionId); if (value.artifact.type !== 'image') throw agentError('NOT_IMAGE', '此产物不是图片'); return store.previewImage(value.bytes); },
    async promptAttachments(ids, sessionId) { const images = [], texts = []; for (const id of ids) { const value = await this.content(id, sessionId); if (value.artifact.type === 'image') images.push(await store.previewImage(value.bytes)); else texts.push(value.bytes.toString('utf8').slice(0, 64000)); } return { images, text: texts.join('\n\n') }; },
    async inspectStorage() { return { unreferenced: await store.unreferenced(repo.storageKeys()) }; },
    content: thisContent,
    async close() { closing = true; clearInterval(expiryTimer); const jobs = [...active.values()]; for (const job of jobs) job.controller.abort(); await Promise.allSettled(jobs.map(job => job.promise)); await workflowBridge?.close(); },
  };
}
