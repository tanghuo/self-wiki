import { matchesType, outputType, inputPorts, safePath, workflowError } from '../../../shared/domain/workflow/contracts.js';
import { modelAdapters } from '../modelAdapters/index.js';
import { createHash } from 'node:crypto';
import { checkJsonSchema } from '../../../shared/domain/workflow/jsonSchema.js';

export function createWorkflowNodes({ repo, store, imageStore, adapters = modelAdapters, executeAgent, model = (snapshot, value) => adapters.model(snapshot, value), generate = (snapshot, value, options) => adapters.generate(snapshot, value, options) }) {
  function readValue(id) {
    const a = repo.artifact(id);
    return a.type === 'image' ? { artifactId: a.id } : a.value;
  }
  function outputArtifact(outputs = {}, port) {
    if (outputs[port]) return outputs[port];
    const legacy = port === 'text' ? outputs.raw || outputs.value : ['structured_output', 'images'].includes(port) ? outputs.value : null;
    const expected = { text: 'text', structured_output: 'json', images: 'list<image>' }[port];
    return legacy && repo.artifact(legacy).type === expected ? legacy : undefined;
  }
  function resolve(binding, siblings, context) {
    if (!binding) return undefined;
    if (binding.kind === 'constant') return binding.value;
    if (binding.kind === 'text') return binding.parts.map((part) => part.kind === 'text' ? part.text : resolve(part.ref, siblings, context)).join('');
    if (binding.kind === 'output') {
      const source = siblings.find((s) => s.nodeId === binding.nodeId);
      const id = outputArtifact(source?.outputs, binding.port);
      if (!id) throw workflowError('上游输出缺失');
      return safePath(readValue(id), binding.path || []);
    }
    if (binding.kind === 'capture') return context.captures?.[binding.name];
    return context[binding.kind];
  }
  function inputs(node, siblings, context) {
    if (['model', 'agent', 'image.generate'].includes(node.type)) node = adapters.normalizeNode(node);
    const values = {};
    for (const [key, type] of Object.entries(inputPorts(node))) {
      values[key] = node.inputs?.[key] ? resolve(node.inputs[key], siblings, context) : key === 'images' ? [] : undefined;
      // Reference-image ports accept one image without a user-authored list node.
      if (type === 'list<image>' && matchesType(values[key], 'image')) values[key] = [values[key]];
      if (!matchesType(values[key], type)) throw workflowError(`节点 ${node.id} 输入 ${key} 的运行时类型错误`);
    }
    return values;
  }
  const local = {
    element({ n, run, values, siblings, i }) { if (n.config.source === 'fixed' && Array.isArray(n.config.parts)) return resolve({ kind: 'text', parts: n.config.parts }, siblings, i.context); return n.config.source === 'upstream' ? values.value : run.inputs[n.config.parameter]; },
    input({ n, run }) { return run.inputs[n.config.parameter]; },
    template({ n, siblings, i }) { return n.config.parts.map((p) => p.kind === 'text' ? p.text : resolve(p.ref, siblings, i.context)).join(''); },
    preview({ values }) { return values.value; },
    transform({ n, values, run }) {
      const c = n.config;
      if (c.operation === 'field') {
        const value = safePath(values.value, c.path || []);
        if (value && typeof value === 'object' && typeof value.artifactRef === 'string') {
          if (!repo.hasAccess(run.id, value.artifactRef)) throw workflowError('字段引用的产物不属于当前运行', 403);
          return safePath(readValue(value.artifactRef), value.path || []);
        }
        return value;
      }
      if (c.operation === 'concat') return (c.keys || ['a', 'b']).map((k) => values[k]).join(c.separator || '');
      if (c.operation === 'list') return c.valueType === 'list<image>' ? (c.keys || ['a', 'b']).flatMap((k) => values[k]) : (c.keys || ['a', 'b']).map((k) => values[k]);
      if (c.operation === 'nth') {
        if (!Number.isSafeInteger(c.index) || c.index < 0 || c.index >= values.value.length) throw workflowError('取第 N 项的索引超出列表');
        return values.value[c.index];
      }
      if (c.operation === 'zip') {
        if (values.a.length !== values.b.length) throw workflowError('zip 两个列表长度必须相等');
        return values.a.map((a, index) => ({ a, b: values.b[index] }));
      }
      if (c.operation === 'successes') return values.value.filter((v) => v.status === 'succeeded');
      throw workflowError('未知数据处理操作');
    },
  };
  async function references(images, run, directory, capability) {
    if (images.length > capability.maxImages) throw workflowError(`执行器最多接受 ${capability.maxImages} 张图片`);
    const paths = [];
    for (const ref of images) {
      if (!repo.hasAccess(run.id, ref.artifactId)) throw workflowError('产物不属于当前运行', 403);
      const a = repo.artifact(ref.artifactId);
      if (a.type !== 'image' || !capability.formats.includes(a.metadata.mime)) throw workflowError('执行器不支持此图片格式');
      paths.push(await store.materialize(a, directory));
    }
    return paths;
  }
  return {
    readValue, outputArtifact, resolve, inputs, resource: (snapshot) => adapters.resource(snapshot),
    async execute({ n, i, run, siblings, signal }) {
      const values = inputs(n, siblings, i.context), c = n.config;
      if (n.type === 'foreach') return { foreach: true, values };
      if (n.type === 'review') return { review: true, value: values.value };
      if (local[n.type]) return { value: await local[n.type]({ n, i, run, siblings, values }) };
      if (['model', 'agent', 'image.generate'].includes(n.type)) {
        const directory = await store.attemptDirectory(i.attemptId);
        const scope = i.scope === 'root' ? 'root' : `root/${i.context.foreachId}`;
        const snapshot = run.executors[`${scope}/${n.id}`];
        if (!snapshot) throw workflowError('适配器快照缺失');
        const capability = adapters.capability(snapshot);
        const images = await references(values.images, run, directory, capability);
        values.prompt ??= '';
        adapters.validateInput(snapshot, values);
        signal.throwIfAborted();
        let dispatched = false;
        const dispatch = () => {
          repo.dispatch(i.id, i.attemptId, { promptHash: createHash('sha256').update(values.prompt).digest('hex'), imageIds: values.images.map((v) => v.artifactId), executor: snapshot.id, version: snapshot.version });
          dispatched = true;
        };
        const progress = (event) => { if (event.type === 'metadata') repo.attemptMetadata(i.attemptId, event.metadata); };
        try {
          if (['model', 'agent'].includes(n.type)) {
            const result = await (n.type === 'agent' ? executeAgent : model)(snapshot, { workflowId: run.workflowId, runId: run.id, instanceId: i.id, prompt: values.prompt, images, workspace: directory, signal, onRequest: dispatch, onProgress: progress });
            const raw = { type: 'text', value: result.text, metadata: { role: 'raw_model_output' } };
            if (outputType(n) === 'json') {
              try { const value = JSON.parse(result.text); if (c.jsonSchema) checkJsonSchema(c.jsonSchema, value); return { value, extra: [{ ...raw, port: 'raw' }] }; }
              catch (e) { return { failed: true, error: `模型 JSON 校验失败，原始文字已保存：${e.message}`, artifacts: [{ ...raw, port: 'raw' }] }; }
            }
            return { value: result.text, extra: [{ ...raw, port: 'raw' }] };
          }
          const result = await generate(snapshot, { prompt: values.prompt, images }, { workspace: directory, signal, onDispatch: dispatch, onProgress: progress });
          const generatedImages = [];
          for (const image of result.images || [result]) generatedImages.push(await store.saveImage(image.bytes, { prompt: values.prompt, referenceIds: values.images.map((r) => r.artifactId), executor: snapshot.id }));
          return { images: generatedImages };
        } catch (error) {
          throw adapters.classifyFailure(snapshot, error, dispatched);
        }
      }
      if (n.type === 'library.save') {
        const source = { runId: run.id, versionId: run.versionId, instanceId: i.id, attemptId: i.attemptId, inputs: n.inputs, label: c.source || '工作流产物' };
        const ids = [], tags = c.tags || [];
        const inputBinding = n.inputs.value;
        if (c.valueType === 'text') {
          // Stable across a failed save attempt, regardless of the new attempt ID.
          const upstream = inputBinding.kind === 'output' && !inputBinding.path?.length && outputArtifact(siblings.find((s) => s.nodeId === inputBinding.nodeId)?.outputs, inputBinding.port);
          let artifactId = upstream;
          if (!artifactId) {
            const result = repo.attempts(i.id).flatMap((a) => Object.values(a.data.outputs || {})).find((id) => repo.artifact(id).metadata.role === 'save_input');
            artifactId = result || null;
          }
          // All values, including constants/captures, get an immutable save-input record.
          if (!artifactId) artifactId = repo.recordValue(i, { type: 'text', value: values.value, metadata: { role: 'save_input' } });
          ids.push(repo.saveLibrary(i.id, artifactId, { body: values.value, tags, source }));
        } else {
          const images = c.valueType === 'image' ? [values.value] : values.value;
          for (const ref of images) {
            signal.throwIfAborted();
            if (!repo.hasAccess(run.id, ref.artifactId)) throw workflowError('无法保存其他运行的图片', 403);
            const a = repo.artifact(ref.artifactId), bytes = await store.read(a);
            const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[a.metadata.mime];
            if (!extension) throw workflowError('不支持保存此图片格式');
            const file = await imageStore.save(bytes, `workflow-${run.id}-${a.id}.${extension}`);
            file.contentHash = a.hash;
            try { ids.push(repo.saveLibrary(i.id, a.id, { file, tags, source })); }
            finally { if (!repo.libraryFileUsed(file.storageKey)) await imageStore.remove(file.storageKey).catch(() => {}); }
          }
        }
        return { value: ids };
      }
      throw workflowError(`节点未注册：${n.type}`);
    },
  };
}
