import { useEffect, useState } from 'react';
import { outputVariables } from '../../../../shared/domain/workflow/contracts.js';
import { checkJsonSchema } from '../../../../shared/domain/workflow/jsonSchema.js';
import { variableLabel } from './workflowLabels.js';

const typeWords = { text: '文字', number: '数字', boolean: '开关', json: '结构化数据', image: '单张图片', 'list<text>': '多段文字', 'list<number>': '数字列表', 'list<boolean>': '开关列表', 'list<json>': '数据列表', 'list<image>': '多张图片' };
export default function WorkflowOutputs({ node, onChange }) {
  const [schema, setSchema] = useState(() => JSON.stringify(node.config.jsonSchema || { type: 'object', properties: {} }, null, 2));
  const [error, setError] = useState('');
  useEffect(() => {
    const value = node.config.jsonSchema || { type: 'object', properties: {} };
    setSchema((previous) => { try { if (JSON.stringify(JSON.parse(previous)) === JSON.stringify(value)) return previous; } catch { /* Keep incomplete edits until the persisted schema changes. */ } return JSON.stringify(value, null, 2); });
    setError('');
  }, [node.config.jsonSchema]);
  return <section className="workflow-outputs"><h4>这一步产出的内容</h4>
    {outputVariables(node).map((variable) => <div key={variable.name} title={variable.name}><span>{variableLabel(variable)}</span><small>{typeWords[variable.type] || variable.type}</small></div>)}
    {node.type === 'model' && node.config.outputType === 'json' && <label>结构化输出 Schema<textarea aria-label="结构化输出 Schema" className="workflow-code" rows={9} value={schema} onChange={(event) => {
      setSchema(event.target.value);
      try { const value = JSON.parse(event.target.value); checkJsonSchema(value, undefined, { validateOnly: true }); onChange({ ...node.config, jsonSchema: value }); setError(''); }
      catch (cause) { setError(cause.message); }
    }} /><small>定义字段的名称和类型；提示词仍需明确要求模型返回符合此结构的 JSON。此处校验回答，不保证适配器支持模型原生约束。</small>{error && <small role="alert">Schema 未应用：{error}</small>}</label>}
  </section>;
}
