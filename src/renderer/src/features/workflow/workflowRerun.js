import { downstreamClosure, executionNode, isRuntimeElement } from '../../../../shared/domain/workflow/contracts.js';

export function rerunChanges(run, definition, inputs) {
  const previous = new Map(run.definition.nodes.map((node) => [node.id, node]));
  const changed = definition.nodes.filter((node) => {
    const before = previous.get(node.id);
    return !before || JSON.stringify(executionNode(before)) !== JSON.stringify(executionNode(node))
      || isRuntimeElement(node) && JSON.stringify(run.inputs[node.config.parameter]) !== JSON.stringify(inputs[node.config.parameter]);
  }).map((node) => node.id);
  return { changed, affected: downstreamClosure(definition.nodes, changed) };
}
