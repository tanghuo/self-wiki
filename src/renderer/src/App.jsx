import { Activity, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Settings, History, X } from "lucide-react";
import WikiApp from "./WikiApp.jsx";
import SettingsDialog from "./SettingsDialog.jsx";
import WikiSidebar from "./WikiSidebar.jsx";
import AgentSourcePreview from "./AgentSourcePreview.jsx";
import TokenUsagePanel from "./TokenUsagePanel.jsx";
import ReferenceTray from "./ReferenceTray.jsx";
import useReferenceTray from "./useReferenceTray.js";
import Dialog from "./Dialog.jsx";
import OrganizationPanel from "./OrganizationPanel.jsx";
import { request } from "./api.js";
import "./wiki.css";

const readOnly = document.querySelector('meta[name="wiki-access"]')?.content === "read-only";
const ChatPanel = lazy(() => import("./ChatPanel.jsx"));
const currentSection = () => readOnly || window.location.hash === "#wiki" ? "wiki" : "agent";

export default function App() {
  const [section, setSection] = useState(currentSection);
  const [chatMounted, setChatMounted] = useState(section === "agent");
  const [visited, setVisited] = useState(() => new Set([section]));
  const workspaceScroll = useRef({});
  const wikiCurrentTab = useRef("all");
  const wikiTabChanged = useCallback((key) => { wikiCurrentTab.current = key; }, []);
  const [docked, setDocked] = useState(false);
  const [wikiTabRequest, setWikiTabRequest] = useState(null), [wikiContext, setWikiContext] = useState([]);
  const [wikiRevision, setWikiRevision] = useState(0), [openRequest, setOpenRequest] = useState(null);
  const refreshWiki = useCallback(() => setWikiRevision((n) => n + 1), []);
  const [sourcePreview, setSourcePreview] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [organizationOpen, setOrganizationOpen] = useState(false), [organizationBusy, setOrganizationBusy] = useState(false);
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || "paper");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // Cookies preserve preferences across the desktop backend's changing ports.
    try { document.cookie = `selfWikiTheme=${theme}; Path=/; Max-Age=31536000; SameSite=Strict`; }
    catch { /* Theme switching still works when preferences cannot be saved. */ }
  }, [theme]);
  const [cardTagDisplay, setCardTagDisplay] = useState(() => {
    try { return document.cookie.split(";").some((entry) => entry.trim() === "selfWikiCardTagDisplay=hover") ? "hover" : "always"; }
    catch { return "always"; }
  });
  useEffect(() => {
    document.documentElement.dataset.cardTagDisplay = cardTagDisplay;
    // The desktop backend changes ports on launch; cookies keep this preference across ports.
    try { document.cookie = `selfWikiCardTagDisplay=${cardTagDisplay}; Path=/; Max-Age=31536000; SameSite=Strict`; }
    catch { /* Browsing still works when preferences cannot be saved. */ }
    return () => { delete document.documentElement.dataset.cardTagDisplay; };
  }, [cardTagDisplay]);
  useEffect(() => {
    const change = () => {
      if (uploading) { window.location.hash = section; return; }
      const next = currentSection();
      if (next !== section) workspaceScroll.current[section] = window.scrollY;
      setSection(next); setDocked(false); setSourcePreview(null);
      setVisited((current) => current.has(next) ? current : new Set([...current, next]));
      if (next === "agent") setChatMounted(true);
      if (next !== "wiki") setOpenRequest(null);
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, [uploading, section]);
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => window.scrollTo(0, workspaceScroll.current[section] || 0));
    return () => cancelAnimationFrame(frame);
  }, [section]);
  const [agentSelection, setAgentSelection] = useState(null);
  const referenceTray = useReferenceTray(!readOnly, wikiRevision);
  const { references, setReferences, collapsed: referencesCollapsed, setCollapsed: setReferencesCollapsed } = referenceTray;
  const [referenceError, setReferenceError] = useState(""), [referenceBusy, setReferenceBusy] = useState(false);
  const referenceStarting = useRef(false);
  function addReference(element) {
    if (referenceStarting.current) return;
    if (element.kind === "video") return;
    setReferencesCollapsed(false); setReferenceError("");
    if (references.some((entry) => entry.id === element.id)) return;
    if (references.length >= 12) { setReferenceError("最多加入 12 份参考，请先移除部分内容。"); return; }
    setReferences((current) => current.some((entry) => entry.id === element.id) ? current : [...current, element].slice(0, 12));
  }
  async function startReferenceChat() {
    if (referenceStarting.current || uploading || referenceTray.unresolved || !references.length) return;
    referenceStarting.current = true; setReferenceBusy(true); setReferenceError("");
    const elements = await referenceTray.validate();
    if (!elements?.length) { referenceStarting.current = false; setReferenceBusy(false); return; }
    setAgentSelection({ newSession: true, elements });
    setChatMounted(true); setDocked(false); setSourcePreview(null); window.location.hash = "agent?new=1";
  }
  function selectionConsumed(acceptedIds) {
    if (agentSelection?.elements) {
      const ids = new Set(acceptedIds);
      setReferences((current) => current.filter((element) => !ids.has(element.id)));
      referenceStarting.current = false; setReferenceBusy(false);
    }
    setAgentSelection(null);
  }
  function selectForAgent(element) { setAgentSelection({ element }); setChatMounted(true); setDocked(true); }
  function askAgent() { setChatMounted(true); setDocked((value) => !value); }
  function closeDock() { setDocked(false); requestAnimationFrame(() => document.querySelector("[data-agent-trigger]")?.focus()); }
  function openSource(id) {
    if (section === "wiki") { setOpenRequest({ id }); if (window.innerWidth <= 1050) closeDock(); }
    else setSourcePreview(id);
  }
  function browseSource(id, contextId) { setOpenRequest({ id, contextId }); setSourcePreview(null); workspaceScroll.current.wiki = 0; window.location.hash = "wiki"; }
  const workspaceNavigation = <>
      <div className="workspace-footer">
        {!readOnly && <button className="text-button workspace-settings" disabled={uploading} onClick={() => setOrganizationOpen(true)}><History size={17} />整理历史</button>}
        {!readOnly && <button className="text-button workspace-settings" onClick={() => setUsageOpen(true)}>Token 用量</button>}
        {!readOnly && <button className="text-button workspace-settings" onClick={() => setSettingsOpen(true)}><Settings size={17} />设置</button>}
        {readOnly && <span className="workspace-local"><i />局域网 · 只读浏览</span>}
      </div>
    </>;
  return <>
    <div className={`app-layout ${section === "agent" ? "agent-home" : docked ? "agent-docked" : ""}`}>
    <div className="app-workspace">
    {visited.has("wiki") && <Activity mode={section === "wiki" ? "visible" : "hidden"}>
      <WikiApp readOnly={readOnly} tabRequest={wikiTabRequest} onTabChange={wikiTabChanged} onBusyChange={setUploading} workspaceNavigation={workspaceNavigation}
        onAddReference={addReference} onAskAgent={askAgent} agentOpen={docked} onContextChange={setWikiContext} externalRevision={wikiRevision} onChanged={refreshWiki} openRequest={openRequest} />
    </Activity>}
    {section === "agent" && <WikiSidebar activeTab="agent" onChooseTab={(key) => { setWikiTabRequest({ key }); if (key !== wikiCurrentTab.current) workspaceScroll.current.wiki = 0; window.location.hash = "wiki"; }}>{workspaceNavigation}</WikiSidebar>}
    </div>
    {chatMounted && !readOnly && <Suspense fallback={section === "agent" || docked ? <section className="agent-loading" role="status">正在打开 Wiki Agent…</section> : null}>
      <ChatPanel selection={agentSelection} onSelectionConsumed={selectionConsumed} presentation={section === "agent" ? "page" : "dock"} visible={section === "agent" || docked} currentIds={section === "wiki" ? wikiContext : []}
        externalBusy={uploading} onOpen={openSource} onChanged={refreshWiki} onClose={closeDock} onExpand={() => { window.location.hash = "agent"; }} />
    </Suspense>}
    </div>
    {!readOnly && (references.length > 0 || referenceTray.error) && <ReferenceTray elements={references} collapsed={referencesCollapsed} onCollapse={setReferencesCollapsed} busy={referenceBusy || uploading} loading={referenceTray.loading} error={referenceTray.error || referenceError} onRetry={referenceTray.error ? referenceTray.retry : undefined} startDisabled={referenceTray.loading || referenceTray.unresolved || !references.length} docked={section !== "agent" && docked}
      onRemove={(id) => { setReferences((current) => current.filter((element) => element.id !== id)); setReferenceError(""); }} onClear={() => { setReferences([]); setReferenceError(""); }}
      onOpen={openSource} onStart={startReferenceChat} />}
    {sourcePreview !== null && <AgentSourcePreview key={sourcePreview} id={sourcePreview} onClose={() => setSourcePreview(null)} onBrowse={browseSource} onReference={(element) => { selectForAgent(element); setSourcePreview(null); }} onAddReference={(element) => { addReference(element); setSourcePreview(null); }} />}
    {settingsOpen && !readOnly && <SettingsDialog theme={theme} onThemeChange={setTheme} cardTagDisplay={cardTagDisplay} onCardTagDisplayChange={setCardTagDisplay} onChanged={refreshWiki} onClose={() => setSettingsOpen(false)} />}
    {usageOpen && !readOnly && <TokenUsagePanel onClose={() => setUsageOpen(false)} />}
    {organizationOpen && !readOnly && <Dialog open label="整理历史" className="wiki-dialog organization-dialog organization-library-dialog" onClose={() => !organizationBusy && setOrganizationOpen(false)}>
      <header className="wiki-dialog-header"><div><h2>整理历史</h2><p className="wiki-muted">查看 AI 为哪些内容补充了标签和关联。</p></div><button className="icon-only" aria-label="关闭整理历史" disabled={organizationBusy} onClick={() => setOrganizationOpen(false)}><X size={18} /></button></header>
      <OrganizationPanel mode="history" onBusyChange={setOrganizationBusy} onChanged={refreshWiki} onOpen={(id) => { setOrganizationOpen(false); browseSource(id); }} />
    </Dialog>}
  </>;
}
