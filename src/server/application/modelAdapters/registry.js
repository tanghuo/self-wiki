import { workflowError } from '../../../shared/domain/workflow/contracts.js';

export function rejectSecrets(value) {
  if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) {
    if (/^(api[_-]?key|authorization|password|secret|token|access[_-]?token|credentials?)$/i.test(key)) throw workflowError('工作流定义及适配器快照不能包含凭证字段');
    rejectSecrets(entry);
  }
}

export function createAdapterRegistry(entries) {
  const byId = new Map();
  for (const entry of entries) {
    if (!entry.id || byId.has(entry.id)) throw new Error('适配器标识缺失或重复');
    byId.set(entry.id, entry);
  }
  function adapter(id, version) {
    const entry = byId.get(id);
    if (!entry || version !== undefined && version !== entry.version) throw workflowError('适配器未注册或版本不可用');
    return entry;
  }
  const commonKeys = ['adapterId', 'executor', 'parameters', 'outputType', 'jsonSchema', 'adapterConfig', 'adapterInputs'];
  return {
    catalog() {
      return entries.map((entry) => ({ id: entry.id, label: entry.label, version: entry.version, nodeType: entry.nodeType,
        inputTypes: entry.inputs(entry.defaults || {}), outputTypes: entry.outputTypes,
        parameterFields: entry.parameterFields || [], configurationEditor: entry.configurationEditor || null,
        defaults: structuredClone(entry.defaults || {}), maxImages: entry.maxImages, formats: entry.formats, cancel: !!entry.cancel, query: !!entry.recover,
      }));
    },
    normalizeNode(node) {
      const id = node.config?.adapterId || node.config?.executor;
      if (!id) return node;
      if (node.config.adapterId && node.config.executor && node.config.adapterId !== node.config.executor) throw workflowError('适配器标识冲突');
      const entry = byId.get(id);
      // An unavailable adapter must not prevent opening and repairing a draft.
      if (!entry) return node;
      if (entry.nodeType !== node.type) throw workflowError('适配器能力与节点不匹配');
      if (node.config.parameters !== undefined && (!node.config.parameters || typeof node.config.parameters !== 'object' || Array.isArray(node.config.parameters))) throw workflowError('适配器任务参数须为对象');
      if (node.config.adapterId && Object.keys(node.config.parameters || {}).some((key) => !(entry.parameterFields || []).some((field) => field.name === key))) throw workflowError('适配器未声明此任务参数');
      if (Object.keys(node.config).some((key) => ![...commonKeys, ...(entry.legacyConfigKeys || [])].includes(key))) throw workflowError('节点包含不支持的适配器配置');
      const config = entry.normalize ? entry.normalize(node.config) : { ...node.config };
      if (config.adapterId) delete config.executor;
      config.adapterInputs = entry.inputs(config);
      return { ...node, config };
    },
    normalizeDefinition(definition) {
      return { ...definition, nodes: definition.nodes.map((node) => node.type === 'foreach' && node.config.body ? { ...node, config: { ...node.config, body: this.normalizeDefinition(node.config.body) } } : ['model', 'image.generate'].includes(node.type) ? this.normalizeNode(node) : node) };
    },
    snapshotDefinition(definition, settings) {
      const result = {};
      const visit = (graph, scope) => {
        for (let node of graph.nodes) {
          if (node.type === 'foreach') visit(node.config.body, `${scope}/${node.id}`);
          if (!['model', 'image.generate'].includes(node.type)) continue;
          node = this.normalizeNode(node);
          const entry = adapter(node.config.adapterId || node.config.executor);
          if (entry.nodeType !== node.type || !entry.outputTypes.includes(node.type === 'model' ? node.config.outputType || 'text' : 'list<image>')) throw workflowError('适配器不支持所选输出');
          const snapshot = { id: entry.id, version: entry.version, ...entry.snapshot(node.config, settings, node) };
          rejectSecrets(snapshot);
          result[`${scope}/${node.id}`] = snapshot;
        }
      };
      visit(definition, 'root'); return result;
    },
    capability(snapshot) { return adapter(snapshot.id, snapshot.version); },
    resource(snapshot) {
      const entry = snapshot && byId.get(snapshot.id);
      return entry && (snapshot.version === undefined || snapshot.version === entry.version) ? entry.resource(snapshot) : null;
    },
    validateInput(snapshot, values) { adapter(snapshot.id, snapshot.version).validateInput?.(snapshot, values); },
    model(snapshot, value) {
      const entry = adapter(snapshot.id, snapshot.version);
      if (!entry.model) throw workflowError('适配器不支持文字调用');
      return entry.model(snapshot, value);
    },
    generate(snapshot, value, options) {
      const entry = adapter(snapshot.id, snapshot.version);
      if (!entry.generate) throw workflowError('适配器不支持图片生成');
      return entry.generate(snapshot, value, options);
    },
    classifyFailure(snapshot, error, dispatched) {
      const entry = adapter(snapshot.id, snapshot.version);
      error.unknown = dispatched && error.unknown !== false && !entry.confirmedFailure?.(error);
      error.serviceFault = [401, 403].includes(error.httpStatus) || /鉴权|认证失效|unauthorized/i.test(error.message);
      return error;
    },
    recoveryTicket(snapshot, attempt) {
      const entry = snapshot && byId.get(snapshot.id);
      return entry && (snapshot.version === undefined || snapshot.version === entry.version) ? entry.recoveryTicket?.(attempt) || null : null;
    },
    configurationRoute(path) {
      const entry = entries.find((candidate) => Object.hasOwn(candidate.legacyConfigurationRoutes || {}, path));
      return entry ? { adapter: entry.id, operation: entry.legacyConfigurationRoutes[path] } : null;
    },
    recover(snapshot, ticket, options) {
      const entry = adapter(snapshot.id, snapshot.version);
      if (!entry.recover || !ticket) throw workflowError('此适配器没有可安全取回的任务', 409);
      return entry.recover(snapshot, ticket, options);
    },
    async configure(id, operation, settings, payload, method) {
      const commands = adapter(id).configuration;
      const command = commands && Object.hasOwn(commands, operation) ? commands[operation] : null;
      if (!command) throw workflowError('适配器不支持此配置操作', 404);
      if (method && method !== command.method) throw workflowError('适配器配置操作不支持此 HTTP 方法', 405);
      const result = await command.execute(settings, payload);
      rejectSecrets(result); return result;
    },
  };
}
