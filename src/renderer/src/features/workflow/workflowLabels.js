import { nodeTypes, dependencies, bindings, outputType, isRuntimeElement, validateDefinition } from '../../../../shared/domain/workflow/contracts.js';

const catalogLabels = Object.fromEntries(nodeTypes.map((node) => [node.type, node.label]));
// Everyday names shown to people. The catalog labels stay in the shared contract
// (and in saved definitions as default names), so both count as "unnamed".
export const friendlyTypeLabels = { element: '内容', input: '内容', template: '文字组合', model: 'AI 写文字', 'image.generate': 'AI 生成图片', transform: '整理数据', foreach: '对每一项重复', review: '我来确认', preview: '预览', 'library.save': '存进资料库' };
export const typeLabel = (type) => friendlyTypeLabels[type] || catalogLabels[type] || type;
const internalId = /^n_[0-9a-f]{6,}$/;
export const isDefaultName = (node) => !node.name || node.name === catalogLabels[node.type] || node.name === friendlyTypeLabels[node.type] || internalId.test(node.name);
const contentLabels = { text: '文字', number: '数字', boolean: '开关', json: '结构化数据', 'list<text>': '多段文字', 'list<number>': '数字列表', 'list<boolean>': '开关列表', 'list<json>': '数据列表' };
export function nodeDisplayName(node) {
  const content = ['element', 'input'].includes(node.type);
  const kind = content ? outputType(node).includes('image') ? '图片' : contentLabels[outputType(node)] || '内容' : typeLabel(node.type);
  return isDefaultName(node) ? kind : node.name;
}

export function workflowSteps(definition) {
  const steps = [];
  function walk(nodes = [], prefix = '', depth = 0, parentId = null) {
    const pending = [...nodes], placed = new Set();
    while (pending.length) {
      const index = pending.findIndex((node) => dependencies(node).every((id) => placed.has(id) || !nodes.some((item) => item.id === id)));
      const [node] = pending.splice(index < 0 ? 0 : index, 1);
      placed.add(node.id);
      steps.push({ id: `${prefix}${node.id}`, node, name: nodeDisplayName(node), number: steps.length + 1, depth, scope: nodes, parentId });
      if (node.type === 'foreach') walk(node.config.body?.nodes, `${prefix}${node.id}/`, depth + 1, node.id);
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
    sourceLabel: isRuntimeElement(step.node) ? '每次运行时填写' : dependencies(step.node).length ? '使用前面步骤的结果' : '固定内容',
  };
}

export function variableLabel(variable) {
  const name = typeof variable === 'string' ? variable : variable.name;
  if (name === 'text') return 'AI 的回答';
  if (name === 'raw') return 'AI 的原始回答';
  if (name === 'structured_output') return '按格式整理的结果';
  if (name?.startsWith('structured_output.')) return '按格式整理的结果.' + name.slice(18);
  return ({ value: '内容', images: '生成的图片', image: '图片' })[name] || name;
}

const portWords = { value: '内容', prompt: '提示词', images: '参考图片', items: '要逐项处理的列表', a: '内容一', b: '内容二' };
function fieldWords(field = '') {
  const port = field.startsWith('inputs.') ? field.slice(7).split('.')[0] : '';
  if (port) return portWords[port] || (/^part_/.test(port) ? '输入' : port.startsWith('capture') ? '带入循环的内容' : '输入');
  if (field.startsWith('config.parts') || field === 'config.default') return '内容';
  return '';
}
const plainMessages = [
  [/必填输入未绑定/, (f) => `「${f || '输入'}」还没有选择内容来源`],
  [/等待手动连线/, (f) => `「${f || '输入'}」还没有连上前面的步骤`],
  [/参数名无效或重复/, () => '内部参数名重复（复制步骤时可能出现），请在「高级设置」里改一个名字'],
  [/引用节点、输出变量或字段不存在/, (f) => `「${f || '输入'}」引用的内容已不存在，请重新选择`],
  [/循环依赖/, () => '步骤之间互相引用，形成了死循环，请断开其中一条连线'],
  [/内容类型错误|常量类型不匹配|类型不匹配/, (f) => `「${f || '内容'}」的类型不对，请重新填写或选择`],
  [/请选择内容来源/, () => '请选择内容来源：固定内容或每次运行时填写'],
  [/缺少循环子图/, () => '循环里还没有步骤'],
  [/循环内请使用 item 或显式捕获/, () => '循环里不能放“每次运行时填写”的内容，请改用「这一项」或带入循环外的内容'],
  [/文字引用只能用于固定文字元素/, () => '只有固定文字可以插入前面步骤的结果'],
  [/未知输入端口/, () => '有一个已经不用的输入，请重新选择这一步的内容来源'],
];
export function plainIssueMessage(error) {
  const words = fieldWords(error.field);
  const hit = plainMessages.find(([pattern]) => pattern.test(error.message || ''));
  return hit ? hit[1](words) : words ? `「${words}」：${error.message}` : error.message;
}

// Find which step an error belongs to. Errors only carry a node id, so look in
// the main flow first and then inside loops.
export function locateIssue(error, definition, steps = workflowSteps(definition)) {
  if (!error.nodeId) return null;
  return steps.find((step) => step.depth === 0 && step.node.id === error.nodeId) || steps.find((step) => step.node.id === error.nodeId) || null;
}

export function missingFixedContent(definition) {
  return (definition?.nodes || []).filter((node) => node.type === 'element' && node.config.source === 'fixed' && !Array.isArray(node.config.parts) && node.config.default === undefined);
}

export function workflowIssues(definition, extra = []) {
  if (!definition) return [];
  const steps = workflowSteps(definition);
  const raw = [...validateDefinition(definition).errors, ...extra];
  const seen = new Set(), issues = [];
  for (const error of raw) {
    const step = locateIssue(error, definition, steps), message = plainIssueMessage(error);
    const key = `${step?.id || ''}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ key, step, message, nodeId: error.nodeId, scope: step?.parentId || null, label: step ? stepLabel(step) : '整个流程' });
  }
  return issues;
}
