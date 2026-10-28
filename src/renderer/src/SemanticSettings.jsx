import { useState } from "react";

export default function SemanticSettings({ config, status, onChange, locked, onAction }) {
  const [query, setQuery] = useState(""), [result, setResult] = useState(null);
  function field(key, value) { onChange({ ...config, [key]: value }); }
  return <fieldset className="semantic-settings" disabled={locked}>
    <legend>语义检索</legend>
    <label><input type="checkbox" checked={config.enabled} onChange={(e) => field("enabled", e.target.checked)} />建立语义索引，帮助 Agent 查找相关内容</label>
    <p className="wiki-muted">索引保存在本地。默认连接本机 Ollama，需先准备 qwen3-embedding:0.6b 模型；也可填写其他兼容服务。文字和图片描述会发送到所配置的向量服务，图片描述由上方执行器生成。</p>
    <div className="settings-subgroup"><h4>服务连接</h4>
    <label>向量服务类型<select value={config.provider} disabled><option value="openai-compatible">OpenAI 兼容 embedding 接口</option></select></label>
    <label>向量服务地址<input value={config.baseUrl} onChange={(e) => field("baseUrl", e.target.value)} placeholder="http://127.0.0.1:11434/v1" /></label>
    <label>向量模型<input value={config.model} onChange={(e) => field("model", e.target.value)} /></label>
    <label>密钥环境变量名（可选）<input value={config.apiKeyEnv || ""} onChange={(e) => field("apiKeyEnv", e.target.value || null)} placeholder="例如 EMBEDDING_API_KEY，本机服务可留空" /></label>
    </div>
    <div className="settings-subgroup"><h4>索引与请求参数</h4>
    <label>向量模型版本<input value={config.modelRevision} onChange={(e) => field("modelRevision", e.target.value)} /></label>
    <p className="wiki-muted">同名模型更新后修改版本号；地址、模型、版本或维数改变会自动重建向量，已有图片描述会复用。</p>
    <label>向量维数<input type="number" min="1" max="8192" value={config.dimensions} onChange={(e) => field("dimensions", Number(e.target.value))} /></label>
    <p className="wiki-muted">填写模型实际输出维数，例如 qwen3-embedding:0.6b 为 1024；此项不会压缩模型输出。</p>
    <label>向量请求超时（秒）<input type="number" min="1" max="300" value={config.timeoutMs / 1000} onChange={(e) => field("timeoutMs", Number(e.target.value) * 1000)} /></label>
    <label>语义候选数量<input type="number" min="1" max="20" value={config.topK} onChange={(e) => field("topK", Number(e.target.value))} /></label>
    </div>
    {status && <div className="settings-subgroup"><h4>索引状态与维护</h4>
      <p role="status" className="wiki-muted">{status.diagnostic}</p>
      <p className="wiki-muted">已索引 {status.counts.ready} · 待索引 {status.counts.pending} · 处理中 {status.counts.running} · 失败 {status.counts.failed}</p>
      {status.activeElementId && <p className="wiki-muted">正在处理内容 #{status.activeElementId}</p>}
      {status.errors.map((error) => <p className="wiki-error" key={error.elementId}>#{error.elementId}：{error.error}</p>)}
      <p className="wiki-muted">先保存下方配置，再检测或重建。重建向量会复用已有图片描述。</p>
      <div className="wiki-actions">
        <button disabled={!status.enabled} onClick={() => onAction("semantic/probe")}>检测向量服务</button>
        <button disabled={!status.enabled} onClick={() => onAction("semantic/rebuild", { mode: "missing" })}>补建索引</button>
        <button disabled={!status.enabled} onClick={() => onAction("semantic/rebuild", { mode: "retry" })}>重试失败项</button>
        <button disabled={!status.enabled} onClick={() => onAction("semantic/rebuild", { mode: "all" })}>重建全部向量</button>
      </div>
      <label>试试语义检索<input value={query} maxLength={2000} onChange={(e) => setQuery(e.target.value)} placeholder="例如：雨夜街头的人物照片" /></label>
      <button disabled={!status.enabled || !query.trim()} onClick={async () => { setResult(null); setResult(await onAction("semantic/search", { query })); }}>查找相关内容</button>
      {result && <div className="semantic-preview" aria-label="语义检索结果">
        <p className="wiki-muted">{result.reason || (result.matches.length ? "相似度用于检索排序，不代表关联成立的概率。" : "暂无可用候选，请等待索引完成。")}</p>
        {result.matches.map((hit) => <p key={hit.elementId}><strong>#{hit.elementId}</strong> · 相似度 {hit.score.toFixed(3)}<br />{hit.preview}</p>)}
      </div>}
    </div>}
  </fieldset>;
}
