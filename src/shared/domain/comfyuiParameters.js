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

function aspect(value) {
  const match = typeof value === 'string' && value.match(/^(\d+(?:\.\d+)?)\s*[:：/]\s*(\d+(?:\.\d+)?)$/);
  return match && Number(match[1]) > 0 && Number(match[2]) > 0 ? Number(match[1]) / Number(match[2]) : null;
}

// Match shape first, then preserve the selected pixel budget within that shape.
export function matchComfyuiImageSize(workflow, fields, width, height) {
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) throw new Error('无法读取参考图尺寸');
  let result = workflow;
  const matches = [];
  for (const field of fields) {
    if (!field.optionsByInput || !result[field.nodeId]) continue;
    const groups = field.optionsByInput.values;
    const ratios = Object.keys(groups).filter(ratio => aspect(ratio) && groups[ratio].some(size => area(size)));
    if (!ratios.length) continue;
    const distance = ratio => Math.abs(Math.log(aspect(ratio) / (width / height)));
    const ratio = ratios.reduce((best, candidate) => distance(candidate) < distance(best) ? candidate : best);
    const node = result[field.nodeId], sizes = groups[ratio].filter(size => area(size));
    const target = area(node.inputs[field.input]) || area(`${node.inputs['自定义宽']}x${node.inputs['自定义高']}`) || width * height;
    const resolution = sizes.reduce((best, candidate) => Math.abs(Math.log(area(candidate) / target)) < Math.abs(Math.log(area(best) / target)) ? candidate : best);
    result = { ...result, [field.nodeId]: { ...node, inputs: { ...node.inputs, [field.optionsByInput.input]: ratio, [field.input]: resolution } } };
    matches.push({ nodeId: field.nodeId, ratio, resolution });
  }
  if (!matches.length) throw new Error('当前工作流没有可匹配的比例与分辨率档位');
  return { workflow: result, matches };
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
