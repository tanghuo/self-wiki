import { Activity, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Settings, History, Keyboard, X } from "lucide-react";
import KeyboardShortcuts from "./KeyboardShortcuts.jsx";
import { isEditableTarget, overlayOpen } from "./shortcuts.js";
import WikiApp from "./WikiApp.jsx";
import SettingsDialog from "./SettingsDialog.jsx";
import WikiSidebar from "./WikiSidebar.jsx";
import AgentSourcePreview from "./AgentSourcePreview.jsx";
import TokenUsagePanel from "./TokenUsagePanel.jsx";
import ReferenceTray from "./ReferenceTray.jsx";
import useReferenceTray from "./useReferenceTray.js";
import Dialog from "./Dialog.jsx";
import OrganizationPanel from "./OrganizationPanel.jsx";
import TemporaryShares from "./TemporaryShares.jsx";
import { request } from "./api.js";
import "./wiki.css";
import "./surfaces.css";
import "./shell.css";

const access = document.querySelector('meta[name="wiki-access"]')?.content;
const readOnly = access === "read-only";
// LAN visitors never get the agent, settings or other local-only tools.
const lanGuest = readOnly || access === "lan-edit";
const ChatPanel = lazy(() => import("./ChatPanel.jsx"));
const WorkflowApp = lazy(() => import('./features/workflow/WorkflowApp.jsx'));
// Empty hash opens the library. Agent is only restored when the user last left it there and the library is not empty.
const currentSection = () => {
  if ((window.location.hash || "").startsWith("#shares")) return "shares";
  if (lanGuest) return "wiki";
  if ((window.location.hash || '').startsWith('#workflow')) return 'workflow';
  const hash = window.location.hash || "";
  if (hash.startsWith("#wiki")) return "wiki";
  if (hash.startsWith("#agent")) return "agent";
  return "wiki";
};

export default function App() {
  const [section, setSection] = useState(currentSection);
  useEffect(() => {
    try { localStorage.setItem("selfWikiSection", section); } catch { /* ignore */ }
  }, [section]);
  useEffect(() => {
    if (lanGuest || (window.location.hash || "").startsWith("#")) return;
    let cancelled = false;
    (async () => {
      try {
        const last = localStorage.getItem("selfWikiSection");
        if (last !== "agent") { if (!cancelled && !window.location.hash) window.location.hash = "wiki"; return; }
        const result = await request("/api/elements?pageSize=1&scope=library");
        if (cancelled) return;
        window.location.hash = result.pagination?.total > 0 ? "agent" : "wiki";
      } catch {
        if (!cancelled && !window.location.hash) window.location.hash = "wiki";
      }
    })();
    return () => { cancelled = true; };
  }, []);
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
  const [settingsSection, setSettingsSection] = useState("general");
  const [usageOpen, setUsageOpen] = useState(false);
  const [organizationOpen, setOrganizationOpen] = useState(false), [organizationBusy, setOrganizationBusy] = useState(false);
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || "auto");
  useEffect(() => {
    // Toolbar "…" menus are <details>; close an open one when the pointer goes elsewhere.
    const close = (event) => { for (const menu of document.querySelectorAll("details.library-menu[open]")) if (!menu.contains(event.target)) menu.open = false; };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
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
  const [shortcutsOpen, setShortcutsOpen] = useState(false), [searchRequest, setSearchRequest] = useState(null);
  const shortcutState = useRef({});
  shortcutState.current = { section, docked, uploading };
  useEffect(() => {
    function keydown(event) {
      if (event.defaultPrevented || event.isComposing || event.altKey) return;
      const { section: current, docked: dockOpen, uploading: busy } = shortcutState.current;
      const typing = isEditableTarget(event.target);
      const searchKey = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "k";
      if (searchKey || (event.key === "/" && !typing && !event.ctrlKey && !event.metaKey)) {
        if (overlayOpen() || busy) return;
        event.preventDefault();
        if (current !== "wiki") window.location.hash = "wiki";
        setSearchRequest({});
        return;
      }
      if (event.key === "?" && !typing && !event.ctrlKey && !event.metaKey && !overlayOpen()) { event.preventDefault(); setShortcutsOpen(true); return; }
      if (event.key === "Escape" && dockOpen && current !== "agent" && !overlayOpen() && event.target.closest?.(".chat-panel")) {
        // Esc inside the docked agent panel closes it (dialogs and menus inside handle Esc first).
        if (!event.target.closest("textarea, input") || !event.target.value) { event.preventDefault(); closeDock(); }
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);
  const [agentSelection, setAgentSelection] = useState(null);
  const referenceTray = useReferenceTray(!lanGuest, wikiRevision);
  const { references, setReferences, collapsed: referencesCollapsed, setCollapsed: setReferencesCollapsed } = referenceTray;
  const [referenceError, setReferenceError] = useState(""), [referenceBusy, setReferenceBusy] = useState(false);
  const referenceStarting = useRef(false);
  function addReference(element) {
    if (referenceStarting.current) return;
    if (element.kind === "video") return;
    setReferencesCollapsed(false); setReferenceError("");
    if (references.some((entry) => entry.id === element.id)) return;
    if (references.length >= 12) { setReferenceError("最多加入 12 份资料，请先移除部分内容。"); return; }
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
  function closeDock() { setDocked(false); requestAnimationFrame(() => [...document.querySelectorAll("[data-agent-trigger]")].find((trigger) => trigger.offsetParent)?.focus()); }
  function openSource(id) {
    if (section === "wiki") { setOpenRequest({ id }); if (window.innerWidth <= 1050) closeDock(); }
    else setSourcePreview(id);
  }
  function browseSource(id, contextId) { setOpenRequest({ id, contextId }); setSourcePreview(null); workspaceScroll.current.wiki = 0; window.location.hash = "wiki"; }
  useEffect(() => {
    const open = (event) => {
      setSettingsSection(event.detail?.section || "general");
      setSettingsOpen(true);
    };
    window.addEventListener("self-wiki-open-settings", open);
    return () => window.removeEventListener("self-wiki-open-settings", open);
  }, []);
  const workspaceNavigation = <>
      <div className="workspace-footer">
        {!lanGuest && <button className="nav-item workspace-settings" onClick={() => { setSettingsSection("general"); setSettingsOpen(true); }}><Settings size={18} />设置</button>}
        <div className="workspace-footer-links">
          <button className="text-button button-sm workspace-shortcuts" aria-keyshortcuts="Shift+?" onClick={() => setShortcutsOpen(true)}><Keyboard size={14} />快捷键</button>
          {!lanGuest && <details className="workspace-tools-more">
            <summary>用量与整理</summary>
            <div className="workspace-tools-more-body">
              <button className="text-button button-sm" disabled={uploading} onClick={() => setOrganizationOpen(true)}><History size={14} />整理历史</button>
              <button className="text-button button-sm" onClick={() => setUsageOpen(true)}>Token 用量</button>
            </div>
          </details>}
        </div>
        {lanGuest && <span className="workspace-local"><i />{readOnly ? "局域网 · 只读浏览" : "局域网 · 可编辑"}</span>}
      </div>
    </>;
  return <>
    <a className="skip-link" href="#main-content" onClick={(event) => {
      event.preventDefault();
      const main = document.getElementById("main-content");
      if (!main?.offsetParent) { document.querySelector(".chat-panel textarea")?.focus(); return; }
      // Focusable only while targeted, so clicks inside the page never move focus to <main>.
      main.setAttribute("tabindex", "-1"); main.focus();
      main.addEventListener("blur", () => main.removeAttribute("tabindex"), { once: true });
    }}>跳到主要内容</a>
    <div className={`app-layout ${section === "agent" ? "agent-home" : docked ? "agent-docked" : ""}`}>
    <div className="app-workspace">
    {visited.has("wiki") && <Activity mode={section === "wiki" ? "visible" : "hidden"}>
      <WikiApp readOnly={readOnly} tabRequest={wikiTabRequest} onTabChange={wikiTabChanged} onBusyChange={setUploading} workspaceNavigation={workspaceNavigation} searchRequest={searchRequest}
        onAddReference={lanGuest ? undefined : addReference} onAskAgent={lanGuest ? undefined : askAgent} agentOpen={docked} onContextChange={setWikiContext} externalRevision={wikiRevision} onChanged={refreshWiki} openRequest={openRequest} />
    </Activity>}
    {section === "agent" && <WikiSidebar activeTab="agent" onChooseTab={(key) => { setWikiTabRequest({ key }); if (key !== wikiCurrentTab.current) workspaceScroll.current.wiki = 0; window.location.hash = "wiki"; }}>{workspaceNavigation}</WikiSidebar>}
    {section === "shares" && <div className="wiki-shell"><WikiSidebar activeTab="shares" readOnly={lanGuest} onChooseTab={(key) => { setWikiTabRequest({ key }); window.location.hash = "wiki"; }}>{workspaceNavigation}</WikiSidebar><TemporaryShares local={!lanGuest} /></div>}
    {visited.has('workflow') && !lanGuest && <Activity mode={section === 'workflow' ? 'visible' : 'hidden'}><div className="wiki-shell"><WikiSidebar activeTab="workflow" onChooseTab={(key) => { setWikiTabRequest({ key }); window.location.hash = 'wiki'; }}>{workspaceNavigation}</WikiSidebar><Suspense fallback={<p role="status">正在打开工作流…</p>}><WorkflowApp /></Suspense></div></Activity>}
    </div>
    {chatMounted && !lanGuest && <Suspense fallback={section === "agent" || docked ? <section className="agent-loading" role="status">正在打开对话…</section> : null}>
      <ChatPanel selection={agentSelection} onSelectionConsumed={selectionConsumed} presentation={section === "agent" ? "page" : "dock"} visible={section === "agent" || docked} currentIds={section === "wiki" ? wikiContext : []}
        externalBusy={uploading} onOpen={openSource} onChanged={refreshWiki} onClose={closeDock} onExpand={() => { window.location.hash = "agent"; }} />
    </Suspense>}
    </div>
    {!lanGuest && (references.length > 0 || referenceTray.error) && <ReferenceTray elements={references} collapsed={referencesCollapsed} onCollapse={setReferencesCollapsed} busy={referenceBusy || uploading} loading={referenceTray.loading} error={referenceTray.error || referenceError} onRetry={referenceTray.error ? referenceTray.retry : undefined} startDisabled={referenceTray.loading || referenceTray.unresolved || !references.length} docked={section !== "agent" && docked}
      onRemove={(id) => { setReferences((current) => current.filter((element) => element.id !== id)); setReferenceError(""); }} onClear={() => { setReferences([]); setReferenceError(""); }}
      onOpen={openSource} onStart={startReferenceChat} />}
    {sourcePreview !== null && <AgentSourcePreview key={sourcePreview} id={sourcePreview} onClose={() => setSourcePreview(null)} onBrowse={browseSource} onReference={(element) => { selectForAgent(element); setSourcePreview(null); }} onAddReference={(element) => { addReference(element); setSourcePreview(null); }} />}
    {settingsOpen && !lanGuest && <SettingsDialog key={settingsSection} initialSection={settingsSection} theme={theme} onThemeChange={setTheme} cardTagDisplay={cardTagDisplay} onCardTagDisplayChange={setCardTagDisplay} onChanged={refreshWiki} onClose={() => setSettingsOpen(false)} />}
    {shortcutsOpen && <KeyboardShortcuts onClose={() => setShortcutsOpen(false)} />}
    {usageOpen && !lanGuest && <TokenUsagePanel onClose={() => setUsageOpen(false)} />}
    {organizationOpen && !lanGuest && <Dialog open label="整理历史" className="wiki-dialog organization-dialog organization-library-dialog" onClose={() => !organizationBusy && setOrganizationOpen(false)}>
      <header className="wiki-dialog-header"><div><h2>整理历史</h2><p className="wiki-muted">查看 AI 为哪些内容补充了标签和关联。</p></div><button className="icon-only" aria-label="关闭整理历史" disabled={organizationBusy} onClick={() => setOrganizationOpen(false)}><X size={18} /></button></header>
      <OrganizationPanel mode="history" onBusyChange={setOrganizationBusy} onChanged={refreshWiki} onOpen={(id) => { setOrganizationOpen(false); browseSource(id); }} />
    </Dialog>}
  </>;
}
