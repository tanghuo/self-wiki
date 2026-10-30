import { chatEngines, defaultChatEngineConfig } from "../../shared/domain/chatEngine.js";

export default function ChatEngineSettings({ value = defaultChatEngineConfig(), locked, onChange }) {
  return <fieldset className="settings-group"><legend>聊天引擎</legend>
    <label>聊天引擎<select aria-label="聊天引擎" value={value.engine} disabled={locked} onChange={(event) => onChange({ ...value, engine: event.target.value })}>
      {chatEngines.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
    </select></label>
    <p className="wiki-muted">这是对话用的引擎。自动整理在「自动整理与检索」里另选 Codex 或 Grok。</p>
    {value.engine === "grok-build" && <>
      <label>Grok 聊天程序路径<input value={value.grokBuild.executable} disabled={locked} onChange={(event) => onChange({ ...value, grokBuild: { ...value.grokBuild, executable: event.target.value } })} placeholder="grok" /></label>
      <label>Grok 聊天默认模型<input value={value.grokBuild.model} disabled={locked} onChange={(event) => onChange({ ...value, grokBuild: { ...value.grokBuild, model: event.target.value } })} /></label>
      <p className="wiki-muted">先在本机运行 grok login。聊天与生图都选择 Grok Build 时，在同一 Grok 会话里连续出图、改图，无需手动重复添加上一张图。重启后加载原会话；切换分支或引擎时重新补入本地历史。保存后到 Agent 对话检测连接。</p>
    </>}
  </fieldset>;
}
