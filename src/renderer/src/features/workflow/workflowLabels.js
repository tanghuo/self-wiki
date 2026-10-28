import { nodeTypes, dependencies, bindings, outputType, isRuntimeElement } from '../../../../shared/domain/workflow/contracts.js';

const nodeLabels = Object.fromEntries(nodeTypes.map((node) => [node.type, node.label]));
const contentLabels = { text: '文字', number: '数字', boolean: '开关', json: '结构化数据', 'list<text>': '多段文字', 'list<number>': '数字列表', 'list<boolean>': '开关列表', 'list<json>': '数据列表' };
export function nodeDisplayName(node) {
  const content = ['element', 'input'].includes(node.type);
  const kind = content ? outputType(node).includes('image') ? '图片' : contentLabels[outputType(node)] || '内容' : nodeLabels[node.type] || node.type;
  return !node.name || node.name === nodeLabels[node.type] ? kind : node.name;
}

export function workflowSteps(definition) {
  const steps = [];
  function walk(nodes = [], prefix = '', depth = 0) {
    const pending = [...nodes], placed = new Set();
    while (pending.length) {
      const index = pending.findIndex((node) => dependencies(node).every((id) => placed.has(id) || !nodes.some((item) => item.id === id)));
      const [node] = pending.splice(index < 0 ? 0 : index, 1);
      placed.add(node.id);
      steps.push({ id: `${prefix}${node.id}`, node, name: nodeDisplayName(node), number: steps.length + 1, depth, scope: nodes });
      if (node.type === 'foreach') walk(node.config.body?.nodes, `${prefix}${node.id}/`, depth + 1);
    }
  }
  walk(definition?.nodes);
  return steps;
}

export const stepLabel = (step) => `第 ${step.number} 步 · ${step.name}`;
export function isPreparationInput(node) {
  if (isRuntimeElement(node)) return true;
  return node.type === 'element' && node.config.source === 'fixed'
    && !bindings(node).some(({ binding }) => binding && binding.kind !== 'constant');
}

export function stepConnections(step, steps) {
  const scoped = steps.filter((item) => item.scope === step.scope);
  return {
    sources: scoped.filter((item) => dependencies(step.node).includes(item.node.id)),
    targets: scoped.filter((item) => dependencies(item.node).includes(step.node.id)),
    sourceLabel: isRuntimeElement(step.node) ? '本次输入' : dependencies(step.node).length ? '引用上游内容' : '流程素材',
  };
}

export function variableLabel(variable) {
  const name = typeof variable === 'string' ? variable : variable.name;
  if (name === 'text') return '回答原文';
  if (name === 'structured_output') return '结构化结果';
  if (name?.startsWith('structured_output.')) return '结构化结果.' + name.slice(18);
  return ({ value: '内容', images: '生成图片' })[name] || name;
}
