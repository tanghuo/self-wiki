import { useCallback, useRef, useState } from "react";
import { Bot, Palette, ScanEye, Tags, Wifi, Sparkles } from "lucide-react";
import LanSharingSettings from "./LanSharingSettings.jsx";
import OrganizationPanel from "./OrganizationPanel.jsx";
import VocabularySettings from "./VocabularySettings.jsx";
import VideoAnalysisSettings from "./VideoAnalysisSettings.jsx";
import ElementUsagePanel from "./ElementUsagePanel.jsx";
import { ConfirmDialog, DialogFrame, SaveBar } from "./ui/index.js";

// Sections whose changes wait for an explicit save. 外观 / 浏览偏好 and 词表 apply immediately, so they get no save bar.
const savedSections = new Set(["sharing", "agent-connect", "agent-org", "video"]);

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

export default function SettingsDialog({ theme, onThemeChange, atmosphere = "full", onAtmosphereChange, liquidGlass = true, onLiquidGlassChange, cardTagDisplay, onCardTagDisplayChange, onChanged, onClose, initialSection = "general" }) {
  const contentRef = useRef(null);
  const [activeSection, setActiveSection] = useState(initialSection);
  const [elementUsageOpen, setElementUsageOpen] = useState(false);
  const [sharingBusy, setSharingBusy] = useState(false);
  const [organizationBusy, setOrganizationBusy] = useState(false);
  const [vocabularyBusy, setVocabularyBusy] = useState(false);
  const [videoBusy, setVideoBusy] = useState(false), [videoDirty, setVideoDirty] = useState(false);
  const [videoOpened, setVideoOpened] = useState(initialSection === "video");
  const [sharingDirty, setSharingDirty] = useState(false), [connectDirty, setConnectDirty] = useState(false), [organizationDirty, setOrganizationDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false), [saving, setSaving] = useState(false);
  // Connection and service sections register {save, discard} here; one save bar at the bottom saves them all.
  // Appearance and browsing preferences apply (and persist) immediately, so they never appear in the bar.
  const savers = useRef({});
  const registerSharing = useCallback((entry) => { savers.current.sharing = entry; }, []);
  const registerConnect = useCallback((entry) => { savers.current["agent-connect"] = entry; }, []);
  const registerOrganization = useCallback((entry) => { savers.current["agent-org"] = entry; }, []);
  const registerVideo = useCallback((entry) => { savers.current.video = entry; }, []);
  const busy = sharingBusy || organizationBusy || vocabularyBusy || videoBusy || saving;
  const dirty = [
    sharingDirty && { id: "sharing", label: "局域网共享" },
    connectDirty && { id: "agent-connect", label: "Agent 连接" },
    organizationDirty && { id: "agent-org", label: "自动整理与检索" },
    videoDirty && { id: "video", label: "视频与画面检索" },
  ].filter(Boolean);
  const dirtyLabel = dirty.map((entry) => entry.label);
  async function saveAll() {
    setSaving(true);
    try { for (const { id } of dirty) await savers.current[id]?.save(); }
    finally { setSaving(false); }
  }
  function discardAll() { for (const { id } of dirty) savers.current[id]?.discard(); }
  function close() {
    if (busy) return;
    if (dirty.length) setConfirmClose(true);
    else onClose();
  }
  function go(id) {
    setActiveSection(id);
    if (id === "video") setVideoOpened(true);
    contentRef.current?.scrollTo(0, 0);
  }
  // The save bar shows on sections that need a save, and anywhere while some section still has unsaved changes.
  const showSaveBar = savedSections.has(activeSection) || dirty.length > 0;
  return <><DialogFrame bare title="设置" className="wiki-dialog settings-dialog" closeLabel="关闭设置" busy={busy} onClose={close}>
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
        <fieldset className="theme-picker">
          <legend>主题色</legend>
          <div className="theme-options">
            {themes.map(({ id, name, description }) => <label key={id} className="theme-option">
              <input type="radio" name="theme" value={id} checked={theme === id} onChange={() => onThemeChange(id)} />
              <span className="theme-preview" data-theme={id} aria-hidden="true"><span className="theme-preview-sidebar" /><span className="theme-preview-content"><i /><span><i /><i /></span></span></span>
              <span className="theme-option-name">{name}</span><span className="theme-option-description">{description}</span>
            </label>)}
          </div>
        </fieldset>
        <fieldset className="atmosphere-picker">
          <legend>氛围色</legend>
          <label className="theme-option" style={{display:"flex",gap:"10px",alignItems:"center",justifyContent:"space-between",padding:"12px 14px",marginTop:"8px"}}>
            <span className="theme-option-name" style={{paddingRight:0}}>减弱氛围色</span>
            <input type="checkbox" style={{position:"static",margin:0}} checked={atmosphere === "soft"} onChange={(event) => onAtmosphereChange?.(event.target.checked ? "soft" : "full")} />
          </label>
          <label className="theme-option" style={{display:"flex",gap:"10px",alignItems:"center",justifyContent:"space-between",padding:"12px 14px",marginTop:"12px"}}>
            <span className="theme-option-name" style={{paddingRight:0}}>液态玻璃</span>
            <input type="checkbox" style={{position:"static",margin:0}} checked={liquidGlass} disabled={typeof CSS !== "undefined" && !CSS.supports("backdrop-filter", "url(#liquid-glass-probe)")} onChange={(event) => onLiquidGlassChange?.(event.target.checked)} />
          </label>
        </fieldset>
      </section>
      <section className="settings-section" aria-labelledby="browsing-settings-heading">
        <header className="settings-section-header"><Tags size={19} /><h3 id="browsing-settings-heading">浏览偏好</h3></header>
        <div className="wiki-form-fields">
          <select aria-label="标签显示" value={cardTagDisplay} onChange={(event) => onCardTagDisplayChange(event.target.value)}>
            <option value="always">始终显示</option>
            <option value="hover">鼠标悬浮时显示</option>
          </select>
        </div>
      </section>
      </div>
      {activeSection === "general" && <details className="element-usage-entry wiki-muted"><summary>本地记录</summary><button className="text-button" onClick={() => setElementUsageOpen(true)}>查看内容使用统计</button></details>}
      <div id="settings-sharing" hidden={activeSection !== "sharing"}><LanSharingSettings onBusyChange={setSharingBusy} onDirtyChange={setSharingDirty} registerSave={registerSharing} /></div>
      <div id="settings-agent-connect" hidden={activeSection !== "agent-connect"}><OrganizationPanel mode="settings" focus="connection" onBusyChange={setOrganizationBusy} onDirtyChange={setConnectDirty} registerSave={registerConnect} /></div>
      <div id="settings-agent-org" hidden={activeSection !== "agent-org"}><OrganizationPanel mode="settings" focus="organization" onBusyChange={setOrganizationBusy} onDirtyChange={setOrganizationDirty} registerSave={registerOrganization} onChanged={onChanged} /></div>
      <div id="settings-video" hidden={activeSection !== "video"}>{videoOpened && <VideoAnalysisSettings onBusyChange={setVideoBusy} onDirtyChange={setVideoDirty} registerSave={registerVideo} onChanged={onChanged} />}</div>
      {activeSection === "vocabulary" && <div id="settings-vocabulary"><VocabularySettings onChanged={onChanged} onBusyChange={setVocabularyBusy} /></div>}
      </div>
    </div>
    {showSaveBar && <SaveBar dirtyCount={dirty.length} dirtyLabels={dirtyLabel} busy={busy} onSave={saveAll} onDiscard={discardAll} />}
  </DialogFrame>
  {elementUsageOpen && <ElementUsagePanel onClose={() => setElementUsageOpen(false)} />}
  {confirmClose && <ConfirmDialog label="未保存的设置" title="还有改动没保存" tone="neutral" cancelLabel="继续编辑"
    confirmLabel="保存改动" busy={busy} busyLabel="正在保存…"
    onCancel={() => { setConfirmClose(false); go(dirty[0]?.id || activeSection); }}
    onConfirm={async () => { await saveAll(); setConfirmClose(false); }}
    extra={<button type="button" className="danger-quiet" disabled={busy} onClick={onClose}>放弃改动并关闭</button>}>
    <p>{dirtyLabel.join("、")}里的改动还没保存。外观和浏览偏好已经自动保存，不受影响。</p>
  </ConfirmDialog>}
  </>;
}
