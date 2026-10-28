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
      <p className="wiki-muted">使用本机 Grok 登录状态，先在终端运行 grok login。默认自动查找用户目录下的 .grok/bin/grok.exe，或从 PATH 查找 grok；不支持 cmd/bat 启动器。支持文生图、最多 8 张参考图编辑与融合，比例在会话中选择。单图编辑保留原图比例。</p>
      <p className="wiki-muted">检测只检查程序版本；登录、额度和图片能力在实际生成时验证。每次返回一张图片，失败不自动重发。停止会终止本地进程，远端任务可能继续。</p>
      <button disabled={locked || !saved} onClick={() => onProbe("grok-build")}>检测 Grok Build</button>
    </div></details>
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
