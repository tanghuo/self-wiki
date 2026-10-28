import { useEffect, useState } from 'react';
import { outputVariables } from '../../../../shared/domain/workflow/contracts.js';
import { checkJsonSchema } from '../../../../shared/domain/workflow/jsonSchema.js';
import { variableLabel } from './workflowLabels.js';

export default function WorkflowOutputs({ node, onChange }) {
  const [schema, setSchema] = useState(() => JSON.stringify(node.config.jsonSchema || { type: 'object', properties: {} }, null, 2));
  const [error, setError] = useState('');
  useEffect(() => {
    const value = node.config.jsonSchema || { type: 'object', properties: {} };
    setSchema((previous) => { try { if (JSON.stringify(JSON.parse(previous)) === JSON.stringify(value)) return previous; } catch { /* Keep incomplete edits until the persisted schema changes. */ } return JSON.stringify(value, null, 2); });
    setError('');
  }, [node.config.jsonSchema]);
  return <section className="workflow-outputs"><h4>输出变量</h4>
    {outputVariables(node).map((variable) => <div key={variable.name}><span>{variableLabel(variable)}<code>{variable.name}</code></span><small>{variable.type}</small></div>)}
    {node.type === 'model' && node.config.outputType === 'json' && <label>结构化输出 Schema<textarea aria-label="结构化输出 Schema" className="workflow-code" rows={9} value={schema} onChange={(event) => {
      setSchema(event.target.value);
      try { const value = JSON.parse(event.target.value); checkJsonSchema(value, undefined, { validateOnly: true }); onChange({ ...node.config, jsonSchema: value }); setError(''); }
      catch (cause) { setError(cause.message); }
    }} /><small>定义字段的名称和类型；提示词仍需明确要求模型返回符合此结构的 JSON。此处校验回答，不保证适配器支持模型原生约束。</small>{error && <small role="alert">Schema 未应用：{error}</small>}</label>}
  </section>;
}
