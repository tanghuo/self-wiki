import { useRef, useState } from "react";
import { Bot, Palette, ScanEye, Tags, Wifi, X, Sparkles } from "lucide-react";
import Dialog from "./Dialog.jsx";
import LanSharingSettings from "./LanSharingSettings.jsx";
import OrganizationPanel from "./OrganizationPanel.jsx";
import VocabularySettings from "./VocabularySettings.jsx";
import VideoAnalysisSettings from "./VideoAnalysisSettings.jsx";
import ElementUsagePanel from "./ElementUsagePanel.jsx";

const themes = [
  { id: "auto", name: "跟随系统", description: "浅色暖纸，深色夜幕" },
  { id: "paper", name: "暖纸", description: "浅色 · 层次清爽" },
  { id: "sage", name: "青苔", description: "柔和灰绿" },
  { id: "night", name: "夜幕", description: "深色 · 突出图片视频" },
  { id: "light", name: "浅色", description: "经典明亮" },
];

const navGroups = [
  {
    label: "常用",
    items: [
      { id: "general", icon: Palette, title: "外观与浏览", description: "主题、卡片标签" },
      { id: "sharing", icon: Wifi, title: "局域网共享", description: "访问地址、开关" },
      { id: "agent-connect", icon: Bot, title: "Agent 连接", description: "聊天引擎、程序与模型" },
    ],
  },
  {
    label: "高级",
    items: [
      { id: "agent-org", icon: Sparkles, title: "自动整理与检索", description: "导入整理、语义索引" },
      { id: "video", icon: ScanEye, title: "视频与画面检索", description: "时间标签、相似画面" },
      { id: "vocabulary", icon: Tags, title: "名称与别名", description: "统一标签、关联叫法" },
    ],
  },
];

export default function SettingsDialog({ theme, onThemeChange, cardTagDisplay, onCardTagDisplayChange, onChanged, onClose, initialSection = "general" }) {
  const contentRef = useRef(null);
  const [activeSection, setActiveSection] = useState(initialSection);
  const [elementUsageOpen, setElementUsageOpen] = useState(false);
  const [sharingBusy, setSharingBusy] = useState(false);
  const [organizationBusy, setOrganizationBusy] = useState(false);
  const [vocabularyBusy, setVocabularyBusy] = useState(false);
  const [videoBusy, setVideoBusy] = useState(false), [videoDirty, setVideoDirty] = useState(false);
  const [videoOpened, setVideoOpened] = useState(initialSection === "video");
  const [sharingDirty, setSharingDirty] = useState(false), [organizationDirty, setOrganizationDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const busy = sharingBusy || organizationBusy || vocabularyBusy || videoBusy;
  const dirtySections = [
    sharingDirty && "局域网共享",
    organizationDirty && (activeSection === "agent-connect" || activeSection === "agent-org" ? "Agent 设置" : "Agent 设置"),
    videoDirty && "视频与画面检索",
  ].filter(Boolean);
  // Deduplicate Agent dirty label when both connect/org share same dirty flag
  const dirtyLabel = [...new Set(dirtySections)];
  function close() {
    if (busy) return;
    if (dirtyLabel.length) setConfirmClose(true);
    else onClose();
  }
  function go(id) {
    setActiveSection(id);
    if (id === "video") setVideoOpened(true);
    contentRef.current?.scrollTo(0, 0);
  }
  return <><Dialog open label="设置" className="wiki-dialog settings-dialog" onClose={close}>
    <header className="wiki-dialog-header"><div><h2>设置</h2></div><button className="icon-only" aria-label="关闭设置" onClick={close} disabled={busy}><X size={18} /></button></header>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分类">
        {navGroups.map((group) => <div key={group.label} className="settings-nav-group">
          <p className="settings-nav-label">{group.label}</p>
          {group.items.map(({ id, icon: Icon, title, description }) => <button key={id} aria-current={activeSection === id ? "page" : undefined} aria-controls={`settings-${id}`} disabled={busy} onClick={() => go(id)}>
            <Icon size={18} /><span><strong>{title}</strong><small>{description}</small></span>
          </button>)}
        </div>)}
      </nav>
      <div className="settings-content" ref={contentRef}>
      <div id="settings-general" hidden={activeSection !== "general"}>
      <section className="settings-section" aria-labelledby="appearance-settings-heading">
        <header className="settings-section-header"><Palette size={19} /><h3 id="appearance-settings-heading">外观</h3></header>
        <fieldset className="theme-picker" aria-describedby="theme-help">
          <legend>主题色</legend>
          <div className="theme-options">
            {themes.map(({ id, name, description }) => <label key={id} className="theme-option">
              <input type="radio" name="theme" value={id} checked={theme === id} onChange={() => onThemeChange(id)} />
              <span className="theme-preview" data-theme={id} aria-hidden="true"><span className="theme-preview-sidebar" /><span className="theme-preview-content"><i /><span><i /><i /></span></span></span>
              <span className="theme-option-name">{name}</span><span className="theme-option-description">{description}</span>
            </label>)}
          </div>
          <p id="theme-help" className="wiki-muted">切换后立即生效并自动保存，内容和画布共用同一主题。</p>
        </fieldset>
      </section>
      <section className="settings-section" aria-labelledby="browsing-settings-heading">
        <header className="settings-section-header"><Tags size={19} /><h3 id="browsing-settings-heading">浏览偏好</h3></header>
        <div className="wiki-form-fields">
          <label>标签显示<select aria-label="标签显示" value={cardTagDisplay} onChange={(event) => onCardTagDisplayChange(event.target.value)} aria-describedby="card-tag-display-help">
            <option value="always">始终显示</option>
            <option value="hover">鼠标悬浮时显示</option>
          </select></label>
          <p id="card-tag-display-help" className="wiki-muted">控制图片和文字卡片上的标签，修改后自动保存。悬浮模式下，键盘聚焦卡片也会显示标签；触屏设备始终显示。</p>
        </div>
      </section>
      </div>
      {activeSection === "general" && <details className="element-usage-entry wiki-muted"><summary>本地记录</summary><button className="text-button" onClick={() => setElementUsageOpen(true)}>查看内容使用统计</button></details>}
      <div id="settings-sharing" hidden={activeSection !== "sharing"}><LanSharingSettings onBusyChange={setSharingBusy} onDirtyChange={setSharingDirty} /></div>
      <div id="settings-agent-connect" hidden={activeSection !== "agent-connect"}><OrganizationPanel mode="settings" focus="connection" onBusyChange={setOrganizationBusy} onDirtyChange={setOrganizationDirty} /></div>
      <div id="settings-agent-org" hidden={activeSection !== "agent-org"}><OrganizationPanel mode="settings" focus="organization" onBusyChange={setOrganizationBusy} onDirtyChange={setOrganizationDirty} onChanged={onChanged} /></div>
      <div id="settings-video" hidden={activeSection !== "video"}>{videoOpened && <VideoAnalysisSettings onBusyChange={setVideoBusy} onDirtyChange={setVideoDirty} onChanged={onChanged} />}</div>
      {activeSection === "vocabulary" && <div id="settings-vocabulary"><VocabularySettings onChanged={onChanged} onBusyChange={setVocabularyBusy} /></div>}
      </div>
    </div>
    <footer className="wiki-dialog-footer">
      {dirtyLabel.length > 0 && <span className="wiki-muted" role="status">尚有未保存：{dirtyLabel.join("、")}（请在对应分区点保存）</span>}
      <button onClick={close} disabled={busy}>关闭</button>
    </footer>
  </Dialog>
  {elementUsageOpen && <ElementUsagePanel onClose={() => setElementUsageOpen(false)} />}
  {confirmClose && <Dialog open label="未保存的设置" className="wiki-dialog" onClose={() => setConfirmClose(false)}>
    <header className="wiki-dialog-header"><h2>还有设置未保存</h2></header>
    <div className="wiki-form-fields"><p>{dirtyLabel.join("、")}中的修改尚未保存。请返回对应分类点击保存，或放弃这些修改。外观等已自动保存的项会保留。</p></div>
    <footer className="wiki-dialog-footer"><button autoFocus onClick={() => { setConfirmClose(false); setActiveSection(sharingDirty ? "sharing" : organizationDirty ? (activeSection === "agent-connect" || activeSection === "agent-org" ? activeSection : "agent-org") : "video"); }}>继续编辑</button><button className="danger-quiet" onClick={onClose}>放弃未保存修改</button></footer>
  </Dialog>}
  </>;
}
