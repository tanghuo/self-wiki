import { workflowError } from './contracts.js';

// Deliberately small JSON Schema subset; unsupported keywords are rejected,
// rather than silently weakening a model node's output contract.
export function checkJsonSchema(schema, value, { validateOnly = false } = {}) {
  function visit(s, v, path, depth) {
    if (depth > 24 || !s || typeof s !== 'object' || Array.isArray(s)) throw workflowError('JSON schema 深度或结构无效');
    if (Object.keys(s).some((k) => !['type', 'properties', 'required', 'items', 'enum', 'additionalProperties', 'description'].includes(k))) throw workflowError('JSON schema 包含不支持的关键字');
    if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(s.type)) throw workflowError('JSON schema 必须声明受支持的 type');
    if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.length)) throw workflowError('JSON schema enum 需要非空数组');
    if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some((k) => typeof k !== 'string'))) throw workflowError('JSON schema required 无效');
    if (s.additionalProperties !== undefined && typeof s.additionalProperties !== 'boolean') throw workflowError('JSON schema additionalProperties 仅支持布尔值');
    if (s.properties !== undefined && (!s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties))) throw workflowError('JSON schema properties 无效');
    if (validateOnly) {
      for (const child of Object.values(s.properties || {})) visit(child, undefined, path, depth + 1);
      if (s.items) visit(s.items, undefined, path, depth + 1);
      return;
    }
    const ok = s.type === 'null' ? v === null : s.type === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : s.type === 'array' ? Array.isArray(v) : s.type === 'integer' ? Number.isSafeInteger(v) : s.type === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeof v === s.type;
    if (!ok) throw workflowError(`模型 JSON ${path} 应为 ${s.type}`);
    if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) throw workflowError(`模型 JSON ${path} 不在 enum 范围`);
    if (s.type === 'object') {
      for (const key of s.required || []) if (!Object.hasOwn(v, key)) throw workflowError(`模型 JSON 缺少 ${path}.${key}`);
      for (const [key, child] of Object.entries(s.properties || {})) if (Object.hasOwn(v, key)) visit(child, v[key], `${path}.${key}`, depth + 1);
      if (s.additionalProperties === false && Object.keys(v).some((k) => !Object.hasOwn(s.properties || {}, k))) throw workflowError(`模型 JSON ${path} 包含未声明字段`);
    }
    if (s.type === 'array' && s.items) v.forEach((item, index) => visit(s.items, item, `${path}[${index}]`, depth + 1));
  }
  visit(schema, value, '$', 0);
}
