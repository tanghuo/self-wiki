export function comfyuiParameterOptions(field, inputs) {
  if (!field.optionsByInput) return field.options;
  const groups = field.optionsByInput.values;
  const selected = groups[inputs[field.optionsByInput.input]];
  if (!Array.isArray(selected)) return field.options;
  const grouped = new Set(Object.values(groups).flat());
  return field.options.filter((option) => selected.includes(option) || !grouped.has(option));
}

function area(value) {
  const match = typeof value === 'string' && value.match(/^(\d+)\s*[×x]\s*(\d+)$/);
  return match ? Number(match[1]) * Number(match[2]) : null;
}

// Keep the closest pixel count when switching aspect ratio. Custom selections
// remain valid across ratios; the saved graph is never mutated in place.
export function alignComfyuiParameters(workflow, fields) {
  let result = workflow;
  for (const field of fields) {
    if (!field.optionsByInput || !result[field.nodeId]) continue;
    const node = result[field.nodeId], current = node.inputs[field.input];
    const options = comfyuiParameterOptions(field, node.inputs);
    if (!options?.length || options.includes(current)) continue;
    const target = area(current), sizes = options.filter((option) => area(option));
    const next = target && sizes.length ? sizes.reduce((best, value) => Math.abs(Math.log(area(value) / target)) < Math.abs(Math.log(area(best) / target)) ? value : best) : options[0];
    result = { ...result, [field.nodeId]: { ...node, inputs: { ...node.inputs, [field.input]: next } } };
  }
  return result;
}
