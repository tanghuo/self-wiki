import { useEffect, useRef, useState } from "react";
import { FileText, ImageIcon, Video, Layers, MessageCircle, MoreHorizontal, Network, Trash2, Share2, Workflow } from "lucide-react";

export const wikiSections = [
  { key: "all", label: "全部内容", icon: Layers },
  { key: "image", label: "图片", icon: ImageIcon },
  { key: "video", label: "视频", icon: Video },
  { key: "text", label: "文字", icon: FileText },
  { key: "canvas", label: "关系画布", icon: Network },
  { key: "trash", label: "回收站", icon: Trash2 },
];

export default function WikiSidebar({ activeTab, onChooseTab, busy, readOnly = false, children }) {
  const local = !['read-only', 'lan-edit'].includes(document.querySelector('meta[name="wiki-access"]')?.content);
  const [utilitiesOpen, setUtilitiesOpen] = useState(false);
  const nav = useRef(null);
  // On phones the navigation is one scrolling row; keep the current page in view.
  useEffect(() => { nav.current?.querySelector("[aria-current='page']")?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }, [activeTab]);
  return <aside className="wiki-sidebar" aria-label="内容导航" data-utilities-open={utilitiesOpen}>
    <a className="workspace-brand" href="#wiki" title="返回内容库"><img className="workspace-brand-mark" src="./brand/self-wiki-64.png" width="32" height="32" alt="" /><strong>self-wiki</strong></a>
    {!readOnly && <button className="wiki-utilities-toggle" aria-label="更多工具" aria-expanded={utilitiesOpen} onClick={() => setUtilitiesOpen((current) => !current)}><MoreHorizontal size={18} /><span>更多</span></button>}
    <nav className="wiki-sidebar-nav" ref={nav} aria-label="页面">
    {!readOnly && <a className="wiki-agent-entry" href="#agent" aria-label="Agent 对话" aria-current={activeTab === "agent" ? "page" : undefined} aria-disabled={busy} onClick={(e) => { if (busy) e.preventDefault(); }}><MessageCircle size={19} /><span><strong>Agent 对话</strong><small>提问与整理</small></span></a>}
    <div className="wiki-sidebar-heading">内容库</div>
    {!readOnly && local && <a className={`wiki-share-entry ${activeTab === 'workflow' ? 'active' : ''}`} href="#workflow" aria-current={activeTab === 'workflow' ? 'page' : undefined} onClick={(event) => { if (busy) event.preventDefault(); }}><Workflow size={18} /><span>工作流</span></a>}
    {wikiSections.filter((entry) => !readOnly || entry.key !== "trash").map(({ key, label, icon: Icon }) => <button key={key} className={activeTab === key ? "active" : ""} onClick={() => onChooseTab(key)} disabled={busy} aria-current={activeTab === key ? "page" : undefined}><Icon size={18} /><span>{label}</span></button>)}
    <a className={`wiki-share-entry ${activeTab === "shares" ? "active" : ""}`} href="#shares" aria-current={activeTab === "shares" ? "page" : undefined} onClick={(event) => { if (busy) event.preventDefault(); }}><Share2 size={18} /><span>临时分享</span></a>
    </nav>
    {children}
  </aside>;
}
