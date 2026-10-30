import { apiUrl } from '../../api.js';
import { isRuntimeElement, outputType } from '../../../../shared/domain/workflow/contracts.js';
import { workflowSteps, stepLabel } from './workflowLabels.js';

export function workflowReferenceImages(definition, inputs, run) {
  return workflowSteps(definition).filter(step => !step.parentId && ['input', 'element'].includes(step.node.type) && ['image', 'list<image>'].includes(outputType(step.node)) && step.node.config.source !== 'upstream').flatMap(step => {
    const node = step.node, original = run?.definition.nodes.find(item => item.id === node.id);
    const useInputs = isRuntimeElement(node) || original && JSON.stringify(original.config) === JSON.stringify(node.config);
    const value = useInputs && Object.hasOwn(inputs, node.config.parameter) ? inputs[node.config.parameter] : node.config.default;
    const images = outputType(node) === 'image' ? value ? [value] : [] : Array.isArray(value) ? value : [];
    return images.flatMap((ref, index) => {
      const path = ref?.elementId ? `/api/elements/${ref.elementId}/image` : ref?.attachmentId ? `/api/workflow-input-images/${ref.attachmentId}/media` : ref?.artifactId && run?.id ? `/api/workflow-artifacts/${ref.artifactId}/media?runId=${run.id}` : null;
      return path ? [{ id: `${step.id}:${index}`, label: `${stepLabel(step)} · 图片 ${index + 1}`, src: apiUrl(path) }] : [];
    });
  });
}
