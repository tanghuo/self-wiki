import { validateDefinition } from '../../../../shared/domain/workflow/contracts.js';
import { workflowTemplates } from '../../../../shared/domain/workflow/examples.js';
import { workflowSteps } from './workflowLabels.js';

/** Match a Chinese one-liner to a starter template and a short plan. */
export function planFromPrompt(prompt, adapters = {}) {
  const text = (prompt || '').trim();
  if (!text) return null;
  const templates = workflowTemplates(adapters);
  const rules = [
    { id: 'describe-images', words: ['反推', '生图', '提示词', '再生成'] },
    { id: 'one-shot', words: ['一句话', '生图并', '挑选', '出图'] },
    { id: 'caption-save', words: ['描述', '写描述', '看图写', '配文'] },
    { id: 'translate', words: ['翻译'] },
    { id: 'polish', words: ['润色', '改写', '校对'] },
  ];
  let best = null, score = 0;
  for (const rule of rules) {
    const hit = rule.words.filter((w) => text.includes(w)).length;
    if (hit > score) { score = hit; best = rule.id; }
  }
  if (!best) {
    if (/图/.test(text) && /写|描述/.test(text)) best = 'caption-save';
    else if (/图/.test(text)) best = 'one-shot';
    else best = 'polish';
  }
  const template = templates.find((t) => t.id === best) || templates[0];
  const definition = structuredClone(template.definition);
  const resultSteps = [];
  for (const node of definition.nodes) {
    if (['library.save', 'review', 'image.generate'].includes(node.type)) resultSteps.push(node.id);
    if (node.type === 'foreach') {
      for (const child of node.config.body?.nodes || []) {
        if (['library.save', 'review', 'image.generate', 'model'].includes(child.type)) resultSteps.push(child.id);
      }
    }
  }
  definition.resultSteps = [...new Set(resultSteps)].slice(0, 6);
  const report = validateDefinition(definition);
  const steps = workflowSteps(definition);
  return {
    template,
    definition,
    name: template.name,
    summary: text,
    maxCalls: report.maxCalls,
    valid: report.valid,
    errors: report.errors,
    steps: steps.filter((s) => s.depth === 0).map((s) => ({ number: s.number, name: s.name, type: s.node.type })),
  };
}
