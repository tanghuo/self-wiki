import ComfyuiSettings from "./ComfyuiSettings.jsx";

export default function ImageGenerationSettings({ config, locked, saved, onChange, onProbe }) {
  function webField(key, value) { onChange({ ...config, chatgptWeb: { ...config.chatgptWeb, [key]: value } }); }
  return <fieldset className="settings-group"><legend>生图服务连接</legend>
    <ComfyuiSettings config={config.comfyui} locked={locked} saved={saved} onChange={(comfyui) => onChange({ ...config, comfyui })} onProbe={() => onProbe("comfyui")} />
    <details className="settings-advanced"><summary>ChatGPT 网页版连接</summary><div className="settings-advanced-content">
      <label>Python 程序路径<input value={config.chatgptWeb.python} disabled={locked} onChange={(event) => webField("python", event.target.value)} placeholder="python" /></label>
      <label>chrome-use 程序路径<input value={config.chatgptWeb.browser} disabled={locked} onChange={(event) => webField("browser", event.target.value)} placeholder="chrome-use" /></label>
      <label>Chrome 配置名称<input value={config.chatgptWeb.profile} disabled={locked} onChange={(event) => webField("profile", event.target.value)} placeholder="relay" /></label>
      <p className="wiki-muted">需要 Python 3.10+、chrome-use 和已登录 ChatGPT 的 Chrome。relay 使用已连接扩展的浏览器；生成记录保留在 ChatGPT 中。多个生图请求依次执行，每张最多等待 30 分钟。</p>
      <p className="wiki-muted">修改后先保存配置，再检测。安装说明见 <a href="https://github.com/leeguooooo/chrome-use" target="_blank" rel="noreferrer">chrome-use 项目</a>。</p>
      <button disabled={locked || !saved} onClick={() => onProbe("chatgpt-web")}>检测网页版生图连接</button>
    </div></details>
  </fieldset>;
}
