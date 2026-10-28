import { configurationEditors } from './configurationEditors.js';

const outputLabels = { text: '文字', json: '结构化数据', 'list<image>': '图片' };
export function newAdapterConfig(adapter) {
  return { adapterId: adapter.id, parameters: {}, ...(adapter.nodeType === 'model' && { outputType: adapter.outputTypes[0] }), ...structuredClone(adapter.defaults), adapterInputs: adapter.inputTypes };
}

export default function ModelAdapterFields({ node, adapters, onChange }) {
  const available = adapters.filter((entry) => entry.nodeType === node.type);
  const selectedId = node.config.adapterId || node.config.executor || '';
  const adapter = available.find((entry) => entry.id === selectedId);
  const config = node.config, editor = configurationEditors[adapter?.configurationEditor];
  const Component = editor?.Component;
  return <div className="workflow-adapter-fields">
    <label>模型适配器<select aria-label="模型适配器" value={selectedId} onChange={(event) => { const next = available.find((entry) => entry.id === event.target.value); if (next) onChange(newAdapterConfig(next)); }}>
      {!adapter && <option value={selectedId}>{selectedId ? '适配器不可用，请重新选择' : '选择适配器…'}</option>}
      {available.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
    </select></label>
    {adapter?.outputTypes.length > 1 && <label>输出格式<select aria-label="输出格式" value={config.outputType || adapter.outputTypes[0]} onChange={(event) => onChange({ ...config, outputType: event.target.value })}>{adapter.outputTypes.map((type) => <option key={type} value={type}>{outputLabels[type] || type}</option>)}</select></label>}
    {adapter?.parameterFields.map((field) => <label key={field.name}>{field.label}<select aria-label={field.label} value={config.parameters?.[field.name] || ''} onChange={(event) => { const parameters = { ...config.parameters }; if (event.target.value) parameters[field.name] = event.target.value; else delete parameters[field.name]; onChange({ ...config, parameters }); }}>
      {field.optional && <option value="">使用适配器默认值</option>}{field.options.map((option) => <option key={option} value={option}>{option}</option>)}
    </select></label>)}
    {Component && <Component key={`${node.id}:${adapter.id}`} adapterId={adapter.id} value={config.adapterConfig} onChange={(value) => onChange(editor.update(config, value))} />}
    {adapter?.configurationEditor && !Component && <p role="alert">当前版本无法编辑此适配器的任务配置。</p>}
  </div>;
}
