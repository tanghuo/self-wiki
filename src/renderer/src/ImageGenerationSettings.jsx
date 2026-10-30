import ComfyuiSettings from "./ComfyuiSettings.jsx";
import { defaultImageGenerationConfig } from "../../shared/domain/imageGeneration.js";

export default function ImageGenerationSettings({ config, locked, saved, onChange, onProbe }) {
  function webField(key, value) { onChange({ ...config, chatgptWeb: { ...config.chatgptWeb, [key]: value } }); }
  const grok = config.grokBuild || defaultImageGenerationConfig().grokBuild;
  function grokField(key, value) { onChange({ ...config, grokBuild: { ...grok, [key]: value } }); }
  return <fieldset className="settings-group"><legend>生图服务连接</legend>
    <ComfyuiSettings config={config.comfyui} locked={locked} saved={saved} onChange={(comfyui) => onChange({ ...config, comfyui })} onProbe={() => onProbe("comfyui")} />
    <details className="settings-advanced"><summary>Grok Build 连接</summary><div className="settings-advanced-content">
      <label>Grok Build 程序路径<input value={grok.executable} disabled={locked} onChange={(event) => grokField("executable", event.target.value)} placeholder="grok 或 grok.exe 的完整路径" /></label>
      <label>Grok 生图调度模型<input value={grok.model} disabled={locked} onChange={(event) => grokField("model", event.target.value)} placeholder="grok-4.6" /></label>
                  <button disabled={locked || !saved} onClick={() => onProbe("grok-build")}>检测 Grok Build</button>
    </div></details>
    <details className="settings-advanced"><summary>ChatGPT 网页版连接</summary><div className="settings-advanced-content">
      <label>Python 程序路径<input value={config.chatgptWeb.python} disabled={locked} onChange={(event) => webField("python", event.target.value)} placeholder="python" /></label>
      <label>chrome-use 程序路径<input value={config.chatgptWeb.browser} disabled={locked} onChange={(event) => webField("browser", event.target.value)} placeholder="chrome-use" /></label>
      <label>Chrome 配置名称<input value={config.chatgptWeb.profile} disabled={locked} onChange={(event) => webField("profile", event.target.value)} placeholder="relay" /></label>
                  <button disabled={locked || !saved} onClick={() => onProbe("chatgpt-web")}>检测网页版生图连接</button>
    </div></details>
  </fieldset>;
}
