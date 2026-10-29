import { useEffect, useRef, useState } from "react";
import { FileText, ImageIcon, Video, Layers, MessageCircle, MoreHorizontal, Network, Trash2, Share2, Workflow } from "lucide-react";

// Content sections shown under 「我的内容」. The trash sits at the bottom of the sidebar.
export const contentSections = [
  { key: "all", label: "全部内容", icon: Layers },
  { key: "image", label: "图片", icon: ImageIcon },
  { key: "video", label: "视频", icon: Video },
  { key: "text", label: "文字", icon: FileText },
  { key: "canvas", label: "关系画布", icon: Network },
];
export const wikiSections = [...contentSections, { key: "trash", label: "回收站", icon: Trash2 }];

// Sidebar groups: Agent 对话 · 我的内容 · 工具 · (bottom) 回收站 and 设置.
export default function WikiSidebar({ activeTab, onChooseTab, busy, readOnly = false, children }) {
  const local = !['read-only', 'lan-edit'].includes(document.querySelector('meta[name="wiki-access"]')?.content);
  const [utilitiesOpen, setUtilitiesOpen] = useState(false);
  const nav = useRef(null);
  // On phones the navigation is one scrolling row; keep the current page in view.
  useEffect(() => { nav.current?.querySelector("[aria-current='page']")?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }, [activeTab]);
  const guard = (event) => { if (busy) event.preventDefault(); };
  const sectionButton = ({ key, label, icon: Icon }) => <button key={key} className={`nav-item ${activeTab === key ? "active" : ""}`} onClick={() => onChooseTab(key)} disabled={busy} aria-current={activeTab === key ? "page" : undefined}><Icon size={18} /><span>{label}</span></button>;
  return <aside className="wiki-sidebar" aria-label="内容导航" data-utilities-open={utilitiesOpen}>
    <a className="workspace-brand" href="#wiki" title="返回内容库"><img className="workspace-brand-mark" src="./brand/self-wiki-64.png" width="28" height="28" alt="" /><strong>self-wiki</strong></a>
    {!readOnly && <button className="wiki-utilities-toggle icon-only" aria-label="更多工具" aria-expanded={utilitiesOpen} onClick={() => setUtilitiesOpen((current) => !current)}><MoreHorizontal size={18} /></button>}
    <nav className="wiki-sidebar-nav" ref={nav} aria-label="页面">
      {!readOnly && <a className={`nav-item wiki-agent-entry ${activeTab === "agent" ? "active" : ""}`} href="#agent" aria-label="Agent 对话" aria-current={activeTab === "agent" ? "page" : undefined} aria-disabled={busy} onClick={guard}><MessageCircle size={18} /><span>Agent 对话</span></a>}
      <div className="wiki-sidebar-heading">我的内容</div>
      {contentSections.map(sectionButton)}
      <div className="wiki-sidebar-heading">工具</div>
      {!readOnly && local && <a className={`nav-item ${activeTab === 'workbench' ? 'active' : ''}`} href="#workbench" aria-current={activeTab === 'workbench' ? 'page' : undefined} onClick={guard}><MessageCircle size={18} /><span>Agent 工作台</span></a>}
      {!readOnly && local && <a className={`nav-item wiki-share-entry ${activeTab === 'workflow' ? 'active' : ''}`} href="#workflow" aria-current={activeTab === 'workflow' ? 'page' : undefined} onClick={guard}><Workflow size={18} /><span>工作流</span></a>}
      <a className={`nav-item wiki-share-entry ${activeTab === "shares" ? "active" : ""}`} href="#shares" aria-current={activeTab === "shares" ? "page" : undefined} onClick={guard}><Share2 size={18} /><span>临时分享</span></a>
      {!readOnly && <div className="wiki-sidebar-bottom">{sectionButton(wikiSections.at(-1))}</div>}
    </nav>
    {children}
  </aside>;
}
