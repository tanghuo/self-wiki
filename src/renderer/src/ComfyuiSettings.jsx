export default function ComfyuiSettings({ config, locked, saved, onChange, onProbe }) {
  return <>
    <label>ComfyUI 服务地址<input type="url" value={config.baseUrl} disabled={locked}
      onChange={(event) => onChange({ ...config, baseUrl: event.target.value })} placeholder="http://127.0.0.1:8188" /></label>
    <p className="wiki-muted">工作流和生成参数在会话输入框旁选择。请先在 ComfyUI 中保存工作流。</p>
    {!saved && <p className="wiki-muted">请先保存配置，再检测连接。</p>}
    <button disabled={locked || !saved} onClick={onProbe}>检测 ComfyUI 连接</button>
  </>;
}
