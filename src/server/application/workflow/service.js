import { checkJsonSchema } from '../../../shared/domain/workflow/jsonSchema.js';
import { nodeTypes, validateDefinition, matchesType, outputType, outputPortName, workflowError, downstreamClosure, workflowLimits, executionNode, preparedElements, isRuntimeElement, bindings, validTextParts, sampleDefinition, loopItems } from '../../../shared/domain/workflow/contracts.js';
import { blankWorkflow, describeImagesExample } from '../../../shared/domain/workflow/examples.js';
import { elementTags } from '../../../shared/domain/elements.js';
import { modelAdapters, rejectSecrets } from '../modelAdapters/index.js';
import { createWorkflowNodes } from './nodes.js';
import { createWorkflowScheduler } from './scheduler.js';

const idNumber = (id) => { const n = Number(id); if (!Number.isSafeInteger(n) || n < 1) throw workflowError('无效 ID'); return n; };
const outputNames = (node, outputs) => Object.fromEntries(Object.keys(outputs).map((port) => [port, outputPortName(node, port)]));
function draft(value, adapters = modelAdapters) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.nodes) || Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw workflowError('定义需要 schemaVersion: 1、nodes，且须在 1 MiB 以内');
  rejectSecrets(value);
  // Drafts may be incomplete, but their containers must be structurally safe to edit/validate.
  let count = 0;
  function visit(g, depth = 0) {
    if (!g || !Array.isArray(g.nodes) || g.nodes.length > 100 || depth > 1) throw workflowError('每作用域最多 100 节点，只支持一层循环');
    count += g.nodes.length;
    if (g.layout?.groups && (!Array.isArray(g.layout.groups) || g.layout.groups.length > 100 || g.layout.groups.some((group) => !group || typeof group.id !== 'string' || !Array.isArray(group.nodeIds) || group.nodeIds.some((id) => typeof id !== 'string')))) throw workflowError('展示分组无效');
    for (const n of g.nodes) {
      if (!n || typeof n !== 'object' || Array.isArray(n) || typeof n.id !== 'string' || !n.config || typeof n.config !== 'object' || Array.isArray(n.config) || n.inputs && (typeof n.inputs !== 'object' || Array.isArray(n.inputs))) throw workflowError('节点结构无效');
      if (!nodeTypes.some((t) => t.type === n.type && t.version === n.version)) throw workflowError('只能导入已注册的节点和契约版本');
      if (n.position && (!Number.isFinite(n.position.x) || !Number.isFinite(n.position.y))) throw workflowError('节点坐标必须是有限数值');
      if (n.type === 'template' && n.config.parts !== undefined && !Array.isArray(n.config.parts)) throw workflowError('模板片段须为数组');
      if (n.type === 'template' && Array.isArray(n.config.parts) && n.config.parts.some((p) => !p || !['text', 'ref'].includes(p.kind) || p.kind === 'text' && typeof p.text !== 'string')) throw workflowError('模板片段须为 text 或 ref 对象');
      if (n.type === 'element' && n.config.parts !== undefined && !validTextParts(n.config.parts)) throw workflowError('文字内容须为文字或引用');
      for (const { binding } of bindings(n)) if (binding?.kind === 'text' && !validTextParts(binding.parts)) throw workflowError('文字内容须为文字或引用');
      if (n.type === 'transform' && n.config.keys !== undefined && (!Array.isArray(n.config.keys) || n.config.keys.some((k) => typeof k !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(k)) || new Set(n.config.keys).size !== n.config.keys.length)) throw workflowError('数据处理输入名称无效');
      if (n.config.captureTypes && (typeof n.config.captureTypes !== 'object' || Array.isArray(n.config.captureTypes))) throw workflowError('捕获类型须为对象');
      if (n.type === 'library.save') elementTags(n.config.tags || []);
      if (n.type === 'model' && n.config.jsonSchema) checkJsonSchema(n.config.jsonSchema, undefined, { validateOnly: true });
      if (n.type === 'foreach' && n.config.body) visit(n.config.body, depth + 1);
    }
  }
  visit(value);
  if (count > 300) throw workflowError('整个定义最多 300 个节点');
  return adapters.normalizeDefinition(structuredClone(value));
}
function name(value) { if (typeof value !== 'string' || !value.trim() || value.length > 160) throw workflowError('名称须为 1–160 字符'); return value.trim(); }

export function createWorkflowService({ repo, store, wiki, imageStore, executionConfig, model, generate, adapters = modelAdapters }) {
  const nodes = createWorkflowNodes({ repo, store, imageStore, model, generate, adapters });
  const scheduler = createWorkflowScheduler({ repo, nodes, store });
  function validation(definition, inputs) {
    const normalized = draft(definition, adapters), report = validateDefinition(normalized);
    try { if (report.valid) adapters.snapshotDefinition(normalized, executionConfig()); } catch (e) { report.errors.push({ field: 'executors', message: e.message }); report.valid = false; }
    if (inputs) for (const n of definition.nodes.filter(isRuntimeElement)) {
      const value = inputs[n.config.parameter] ?? n.config.default;
      if (value === undefined || !matchesType(value, outputType(n)) || n.config.allowEmpty === false && Array.isArray(value) && !value.length) { report.valid = false; report.errors.push({ nodeId: n.id, field: 'inputs', message: '运行参数缺失、类型错误或不允许空列表' }); }
    }
    return report;
  }
  async function prepareInputs(definition, payload, parent) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw workflowError('运行输入须为对象');
    const inputs = {}, images = [], sourceCopies = new Map();
    async function image(value) {
      if (value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.attachmentId === 'string') {
        if (!sourceCopies.has(value.attachmentId)) {
          const source = await store.inputImage(value.attachmentId);
          const saved = await store.saveImage(source.bytes, { sourceAttachmentId: value.attachmentId, originalName: source.artifact.metadata.originalName });
          images.push(saved); sourceCopies.set(value.attachmentId, { artifactId: saved.id });
        }
        return sourceCopies.get(value.attachmentId);
      }
      if (value && typeof value === 'object' && Object.keys(value).length === 1 && Number.isSafeInteger(value.elementId) && value.elementId > 0) {
        if (!sourceCopies.has(value.elementId)) {
          const source = await wiki.image(value.elementId);
          const saved = await store.saveImage(source.bytes, { sourceElementId: value.elementId });
          images.push(saved); sourceCopies.set(value.elementId, { artifactId: saved.id });
        }
        return sourceCopies.get(value.elementId);
      }
      if (matchesType(value, 'image') && parent && repo.hasAccess(parent.id, value.artifactId)) { const a = repo.artifact(value.artifactId); if (a.type !== 'image') throw workflowError('输入产物不是图片'); await store.read(a); return value; }
      throw workflowError('图片输入只接受工作流附件 attachmentId、资料库 elementId 或父运行拥有的 artifactId，不接受文件路径');
    }
    const parameters = new Set(definition.nodes.filter(isRuntimeElement).map((n) => n.config.parameter));
    if (Object.keys(payload).some((k) => !parameters.has(k))) throw workflowError('包含未声明的运行参数');
    for (const n of preparedElements(definition)) {
      const c = n.config;
      const previous = parent?.definition.nodes.find((before) => before.id === n.id);
      const reuseFixed = !isRuntimeElement(n) && previous && JSON.stringify(executionNode(previous)) === JSON.stringify(executionNode(n));
      let value = reuseFixed ? parent.inputs[c.parameter] : isRuntimeElement(n) && Object.hasOwn(payload, c.parameter) ? payload[c.parameter] : c.default;
      if (outputType(n) === 'text' && value && typeof value === 'object' && Object.keys(value).length === 1 && Number.isSafeInteger(value.elementId)) {
        const source = wiki.get(value.elementId);
        if (source.kind !== 'text') throw workflowError('文字参数只能引用文字资料');
        value = source.body;
        images.push({ type: 'text', value, metadata: { sourceElementId: source.id, parameter: c.parameter } });
      }
      if (value === undefined) {
        if (!isRuntimeElement(n) || c.required !== false) throw workflowError(`请为${isRuntimeElement(n) ? '本次输入' : '固定素材'}「${n.name || n.id}」（${n.id}，${outputType(n)}）提供内容${isRuntimeElement(n) ? '' : '，可在运行准备页填写'}`);
        value = outputType(n).startsWith('list<') ? [] : outputType(n) === 'text' ? '' : outputType(n) === 'number' ? 0 : outputType(n) === 'boolean' ? false : {};
      }
      if (outputType(n) === 'image') value = await image(value);
      if (outputType(n) === 'list<image>') {
        if (!Array.isArray(value) || value.length > workflowLimits.items) throw workflowError('图片列表最多 1000 项');
        const refs = []; for (const v of value) refs.push(await image(v)); value = refs;
      }
      if (!matchesType(value, outputType(n)) || c.allowEmpty === false && Array.isArray(value) && !value.length) throw workflowError(`参数 ${c.parameter} 类型错误或不允许空列表`);
      if (Array.isArray(value) && value.length > workflowLimits.items) throw workflowError('输入列表最多 1000 项');
      inputs[c.parameter] = value;
    }
    return { inputs, images };
  }
  function checkedDefinition(value) {
    const d = draft(value, adapters), report = validation(d);
    if (!report.valid) throw workflowError(report.errors.map((e) => `${e.nodeId || ''} ${e.field}: ${e.message}`).join('；'));
    return d;
  }
  function canRecover(run, instance, attempts) {
    if (instance.state !== 'unknown') return false;
    const scope = instance.scope === 'root' ? 'root' : 'root/' + instance.context.foreachId;
    const snapshot = run.executors[scope + '/' + instance.nodeId];
    const attempt = (attempts || repo.attempts(instance.id)).find((entry) => entry.id === instance.attemptId);
    return !!adapters.recoveryTicket(snapshot, attempt);
  }
  function nodeAction(runId, instanceId, payload) {
    const r = repo.run(runId), i = repo.instance(instanceId);
    if (i.runId !== r.id) throw workflowError('节点不属于此运行', 404);
    const graph = i.scope === 'root' ? r.definition : r.definition.nodes.find((n) => n.id === i.context.foreachId).config.body;
    const n = graph.nodes.find((n) => n.id === i.nodeId);
    repo.bumpControl(runId, payload.controlVersion);
    let result;
    if (['accept', 'reject'].includes(payload.action)) {
      if (payload.action === 'accept' && Object.hasOwn(payload, 'value')) {
        if (!matchesType(payload.value, outputType(n))) throw workflowError('人工修改值类型错误');
        if (outputType(n) === 'list<image>') {
          const original = nodes.readValue(i.outputs.value).map((v) => v.artifactId);
          if (new Set(payload.value.map((v) => v.artifactId)).size !== payload.value.length || payload.value.some((v) => !original.includes(v.artifactId))) throw workflowError('检查图片只能选择原列表子集');
        }
      }
      result = repo.review(i.id, payload.action, payload.value);
    } else if (['retry', 'reexecute'].includes(payload.action)) {
      if (payload.action === 'reexecute' && payload.acknowledgeDuplicate !== true) throw workflowError('重新执行未知任务须 acknowledgeDuplicate: true，原任务可能已完成并产生额外调用');
      if (i.context.parentInstanceId) {
        const parent = repo.instance(i.context.parentInstanceId), affected = downstreamClosure(r.definition.nodes, [parent.nodeId]);
        if (repo.instances(runId, { scope: 'root' }).some((s) => s.id !== parent.id && affected.has(s.nodeId) && ['succeeded', 'running', 'waiting_review'].includes(s.state))) throw workflowError('循环汇总已被下游消费，请派生运行重新执行，避免覆盖已使用的结果', 409);
      }
      result = repo.retry(i.id, payload.action === 'reexecute');
      if (i.context.parentInstanceId) {
        const parent = repo.instance(i.context.parentInstanceId);
        if (parent.state !== 'running') repo.setInstance(parent.id, 'pending');
      }
    } else if (payload.action === 'abandon') {
      if (i.state !== 'unknown') throw workflowError('仅能明确放弃未知结果', 409);
      repo.setInstance(i.id, 'cancelled', '本机用户明确放弃未知结果');
      result = repo.instance(i.id);
    } else if (payload.action === 'recover') throw workflowError('此执行器未注册远端取回能力；请核查远端后重新执行或放弃', 409);
    else throw workflowError('未知节点动作');
    return result;
  }
  return {
    addInputImage(bytes, originalName) {
      if (typeof originalName !== 'string' || originalName.length > 512) throw workflowError('图片文件名过长');
      return store.saveInputImage(bytes, originalName);
    },
    async inputImage(id) {
      const source = await store.inputImage(id);
      return { bytes: source.bytes, contentType: source.artifact.metadata.mime };
    },
    start: () => scheduler.start(), close: () => scheduler.close(),
    adapterConfiguration: (id, operation, payload, method) => adapters.configure(id, operation, executionConfig(), payload, method),
    adapterConfigurationRoute: (path) => adapters.configurationRoute(path),
    catalog: () => ({ nodeTypes, adapters: adapters.catalog(), limits: workflowLimits, examples: [{ id: 'describe-images', name: '批量反推并生图' }] }),
    list: () => repo.list(),
    get: (id) => { const w = repo.workflow(idNumber(id)); return { ...w, definition: adapters.normalizeDefinition(w.definition), runs: repo.history(w.id) }; },
    create(payload) {
      const directory = adapters.catalog(), textAdapter = directory.find((entry) => entry.nodeType === 'model')?.id, imageAdapter = directory.find((entry) => entry.nodeType === 'image.generate')?.id;
      if (payload.example === 'describe-images' && (!textAdapter || !imageAdapter)) throw workflowError('该示例需要文字和图片适配器');
      const definition = payload.example === 'describe-images' ? describeImagesExample({ textAdapter, imageAdapter }) : payload.definition || blankWorkflow();
      return repo.command('workflow.create', payload.requestKey, payload, () => repo.create(name(payload.name), draft(definition, adapters)));
    },
    save(id, payload) {
      id = idNumber(id);
      return repo.save(id, { ...payload, archived: payload.archived ?? !!repo.workflow(id).archivedAt, name: name(payload.name), definition: draft(payload.definition, adapters) });
    },
    validate(id, payload) { return validation(payload.definition || repo.workflow(idNumber(id)).definition); },
    async createRun(id, payload) {
      id = idNumber(id);
      const scope = `workflow.run:${id}`, prior = repo.priorCommand(scope, payload.requestKey, payload);
      if (prior) return prior;
      const w = repo.workflow(id);
      if (payload.revision !== w.revision) throw workflowError('草稿已改变，请保存并刷新', 409);
      if (payload.sample !== undefined && typeof payload.sample !== 'boolean') throw workflowError('试跑选项须为布尔值');
      // A run can carry temporary settings without overwriting the saved draft.
      const checked = checkedDefinition(payload.definition ?? w.definition), definition = payload.sample ? sampleDefinition(checked) : checked, executors = adapters.snapshotDefinition(definition, executionConfig());
      const prepared = await prepareInputs(definition, payload.inputs || {});
      const result = repo.command(scope, payload.requestKey, payload, () => {
        if (repo.workflow(id).revision !== payload.revision) throw workflowError('准备输入时草稿已改变', 409);
        return repo.createRun(id, definition, prepared.inputs, executors, prepared.images);
      });
      scheduler.wake(); return result;
    },
    run(id, { after = 0, limit = 100 } = {}) {
      id = idNumber(id);
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw workflowError('分页参数无效');
      const r = repo.run(id), instances = repo.instances(id, { after, limit });
      const rootInstances = repo.instances(id, { scope: 'root' });
      const byInstance = repo.attemptsFor([...rootInstances, ...instances].map((i) => i.id));
      const present = (i) => {
        const attempts = byInstance.get(i.id) || [];
        const node = (i.scope === 'root' ? r.definition.nodes : r.definition.nodes.find((n) => n.id === i.context.foreachId)?.config.body.nodes)?.find((n) => n.id === i.nodeId);
        return { ...i, name: node?.name, outputNames: outputNames(node, i.outputs), context: { index: i.context.index, parentInstanceId: i.context.parentInstanceId }, attempts, canRecover: canRecover(r, i, attempts) };
      };
      return { ...r, definition: adapters.normalizeDefinition(r.definition), inputArtifacts: repo.inputArtifacts(id), rootInstances: rootInstances.map(present), instances: instances.map(present), nextCursor: instances.at(-1)?.id || after };
    },
    events(id, after) { if (!Number.isSafeInteger(after) || after < 0) throw workflowError('事件游标无效'); const events = repo.events(idNumber(id), after); return { events, cursor: events.at(-1)?.id || after }; },
    batch(id, instanceId, offset = 0) {
      id = idNumber(id); instanceId = idNumber(instanceId);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000) throw workflowError('批次分页参数无效');
      const r = repo.run(id), parent = repo.instance(instanceId), n = r.definition.nodes.find((n) => n.id === parent.nodeId);
      if (parent.runId !== id || parent.scope !== 'root' || n?.type !== 'foreach') throw workflowError('循环实例不存在', 404);
      const all = repo.instances(id);
      const completedRows = parent.outputs.value ? nodes.readValue(parent.outputs.value) : [];
      let items;
      try { items = loopItems(n, nodes.inputs(n, all.filter((i) => i.scope === 'root'), {}).items); } catch { return { items: [], total: 0, preparing: true }; }
      const visibleInstances = all.filter((i) => i.context.parentInstanceId === parent.id && i.context.index >= offset && i.context.index < offset + 20);
      const byInstance = repo.attemptsFor(visibleInstances.map((i) => i.id));
      return { total: items.length, offset, items: items.slice(offset, offset + 20).map((value, localIndex) => {
        const index = localIndex + offset, group = all.filter((i) => i.context.parentInstanceId === parent.id && i.context.index === index);
        const state = !group.length && completedRows[index] ? completedRows[index].status : group.some((i) => i.state === 'unknown') ? 'unknown' : group.some((i) => i.state === 'waiting_review') ? 'waiting_review' : group.some((i) => ['pending', 'running'].includes(i.state)) || !group.length ? 'pending' : group.some((i) => ['failed', 'blocked'].includes(i.state)) ? 'failed' : group.some((i) => i.state === 'cancelled') ? 'cancelled' : 'succeeded';
        return { itemId: `${id}:${n.id}:${index}`, index, value, state, resultArtifacts: !group.length ? completedRows[index]?.outputs || {} : {}, instances: group.map((i) => ({ ...i, canRecover: canRecover(r, i, byInstance.get(i.id) || []), name: n.config.body.nodes.find((node) => node.id === i.nodeId)?.name, outputNames: outputNames(n.config.body.nodes.find((node) => node.id === i.nodeId), i.outputs), context: { index, parentInstanceId: parent.id }, attempts: byInstance.get(i.id) || [] })) };
      }) };
    },
    control(id, payload) {
      id = idNumber(id);
      const result = repo.command(`workflow.control:${id}`, payload.requestKey, payload, () => repo.control(id, payload.action, payload.controlVersion));
      if (payload.action === 'cancel') scheduler.cancel(id);
      scheduler.settle(id); scheduler.wake(); return { ...result, state: repo.run(id).state };
    },
    nodeAction(id, instId, payload) {
      id = idNumber(id); instId = idNumber(instId);
      if (payload.action === 'recover') return (async () => {
        const scope = `workflow.node:${id}:${instId}`, prior = repo.priorCommand(scope, payload.requestKey, payload);
        if (prior) return { instance: prior, controlVersion: repo.run(id).controlVersion };
        const r = repo.run(id), i = repo.instance(instId);
        if (i.runId !== id || i.state !== 'unknown' || r.controlVersion !== payload.controlVersion) throw workflowError('未知节点或控制版本已改变', 409);
        const snapshot = r.executors[`${i.scope === 'root' ? 'root' : `root/${i.context.foreachId}`}/${i.nodeId}`];
        if (!snapshot) throw workflowError('适配器快照缺失', 409);
        const attempt = repo.attempts(instId).find((a) => a.id === i.attemptId), ticket = adapters.recoveryTicket(snapshot, attempt);
        const result = await adapters.recover(snapshot, ticket, { signal: AbortSignal.timeout(30000) });
        const image = await store.saveImage(result.bytes, { recoveredFrom: { attemptId: i.attemptId, ticket }, executor: snapshot.id });
        const saved = repo.command(scope, payload.requestKey, payload, () => {
          repo.bumpControl(id, payload.controlVersion);
          return repo.recoverUnknown(instId, i.attemptId, [{ ...image, port: `image:${image.id}` }, { type: 'list<image>', value: [{ artifactId: image.id }], metadata: { recovered: true } }]);
        });
        scheduler.settle(id); scheduler.wake(); return { instance: saved, controlVersion: repo.run(id).controlVersion };
      })();
      const result = repo.command(`workflow.node:${id}:${instId}`, payload.requestKey, payload, () => nodeAction(id, instId, payload));
      scheduler.settle(id); scheduler.wake(); return { instance: result, controlVersion: repo.run(id).controlVersion };
    },
    batchReview(id, payload) {
      id = idNumber(id);
      if (!Array.isArray(payload.instanceIds) || !payload.instanceIds.length || payload.instanceIds.length > 100 || new Set(payload.instanceIds).size !== payload.instanceIds.length || payload.action !== 'accept') throw workflowError('请选择 1–100 个不同的检查节点');
      const result = repo.command(`workflow.reviews:${id}`, payload.requestKey, payload, () => {
        let controlVersion = payload.controlVersion;
        for (const instId of payload.instanceIds) { nodeAction(id, idNumber(instId), { action: 'accept', controlVersion }); controlVersion++; }
        return { controlVersion };
      });
      scheduler.settle(id); scheduler.wake(); return result;
    },
    async artifact(id, runId, media = false) {
      runId = idNumber(runId);
      if (!repo.hasAccess(runId, id)) throw workflowError('产物不属于请求运行', 404);
      const a = repo.artifact(id);
      if (media) { if (a.type !== 'image') throw workflowError('此产物不是图片'); return { bytes: await store.read(a), contentType: a.metadata.mime }; }
      const { storageKey, ...publicValue } = a;
      return publicValue;
    },
    async derive(id, payload) {
      id = idNumber(id);
      const scope = `workflow.derive:${id}`, prior = repo.priorCommand(scope, payload.requestKey, payload);
      if (prior) return prior;
      const parent = repo.run(id), definition = checkedDefinition(payload.definition || parent.definition);
      if (payload.regenerate !== undefined && (!Array.isArray(payload.regenerate) || payload.regenerate.some((id) => !definition.nodes.some((n) => n.id === id)))) throw workflowError('regenerate 必须引用主作用域中的节点 ID 数组');
      const executors = adapters.snapshotDefinition(definition, executionConfig());
      const inherited = Object.fromEntries(definition.nodes.filter(isRuntimeElement).filter((n) => Object.hasOwn(parent.inputs, n.config.parameter)).map((n) => [n.config.parameter, parent.inputs[n.config.parameter]]));
      const prepared = await prepareInputs(definition, payload.inputs || inherited, parent);
      const old = new Map(parent.definition.nodes.map((n) => [n.id, n])), changed = new Set(payload.regenerate || []);
      for (const n of definition.nodes) {
        const before = old.get(n.id);
        if (!before || JSON.stringify(executionNode(before)) !== JSON.stringify(executionNode(n)) || preparedElements(definition).includes(n) && JSON.stringify(parent.inputs[n.config.parameter]) !== JSON.stringify(prepared.inputs[n.config.parameter])
          || JSON.stringify(parent.executors[`root/${n.id}`]) !== JSON.stringify(executors[`root/${n.id}`])) changed.add(n.id);
        // Child executor changes invalidate their containing loop.
        if (n.type === 'foreach' && JSON.stringify(Object.entries(parent.executors).filter(([k]) => k.startsWith(`root/${n.id}/`))) !== JSON.stringify(Object.entries(executors).filter(([k]) => k.startsWith(`root/${n.id}/`)))) changed.add(n.id);
      }
      const invalid = downstreamClosure(definition.nodes, changed), sources = repo.instances(id, { scope: 'root' });
      // Verify referenced files before entering a short commit transaction.
      const reusable = [];
      for (const n of definition.nodes) {
        const source = sources.find((s) => s.nodeId === n.id && s.state === 'succeeded');
        if (!source || invalid.has(n.id)) continue;
        try {
          const artifacts = Object.values(source.outputs).map((v) => repo.artifact(v));
          for (const a of artifacts) {
            if (a.type === 'image') await store.read(a);
            for (const referenced of references(a.value)) { const target = repo.artifact(referenced); if (target.type === 'image') await store.read(target); }
          }
          reusable.push(source);
        } catch { for (const affected of downstreamClosure(definition.nodes, [n.id])) invalid.add(affected); }
      }
      const result = repo.command(scope, payload.requestKey, payload, () => {
        const r = repo.createRun(parent.workflowId, definition, prepared.inputs, executors, prepared.images, id);
        for (const source of reusable.filter((s) => !invalid.has(s.nodeId))) {
          const target = repo.instances(r.id, { scope: 'root' }).find((i) => i.nodeId === source.nodeId);
          repo.reuse(target.id, source);
          for (const artifactId of Object.values(source.outputs)) for (const referenced of references(nodes.readValue(artifactId))) repo.addRef(r.id, target.id, referenced, 'reuse');
        }
        repo.event(r.id, 'run.derived', null, null, { parentId: id, invalidated: [...invalid] });
        return r;
      });
      scheduler.wake(); return result;
    },
    editVersion(id, payload) {
      id = idNumber(id);
      return repo.command(`workflow.edit-version:${id}`, payload.requestKey, payload, () => { const r = repo.run(id); return repo.create(name(payload.name || `历史版本 ${r.version} 的副本`), adapters.normalizeDefinition(r.definition)); });
    },
  };
  function references(value, ids = new Set()) {
    if (value && typeof value === 'object') {
      const id = value.artifactId || value.artifactRef;
      if (typeof id === 'string' && !ids.has(id)) { ids.add(id); const a = repo.artifact(id); if (a.type !== 'image') references(a.value, ids); }
      else if (!id) for (const v of Object.values(value)) references(v, ids);
    }
    return ids;
  }
}
