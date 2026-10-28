import ComfyuiConfiguration from './ComfyuiConfiguration.jsx';

export function generationParameterConfig(node) {
  if (node?.type !== 'image.generate' || (node.config.adapterId || node.config.executor) !== 'comfyui') return null;
  return node.config.adapterConfig || node.config.comfyui || null;
}

export function withGenerationParameters(definition, overrides) {
  const update = (node, scope = '') => {
    const config = overrides[scope + node.id];
    if (config) return { ...node, config: { ...node.config, adapterConfig: config } };
    if (node.type === 'foreach') return { ...node, config: { ...node.config, body: { ...node.config.body, nodes: node.config.body.nodes.map((child) => update(child, node.id + '/')) } } };
    return node;
  };
  return { ...definition, nodes: definition.nodes.map((node) => update(node)) };
}

export default function RuntimeGenerationParameters({ node, value, onChange, regenerate = false }) {
  const config = value || generationParameterConfig(node);
  if (!config) return null;
  return <ComfyuiConfiguration adapterId="comfyui" value={config} parametersOnly
    buttonLabel={regenerate ? '调整参数' : '调整本次生图参数'}
    applyLabel={regenerate ? '保存参数' : '应用到本次运行'} onChange={onChange} />;
}
