import { useState } from "react";
import { FileText, ImageIcon, Video, Layers, MessageCircle, MoreHorizontal, Network, Trash2 } from "lucide-react";

export const wikiSections = [
  { key: "all", label: "全部内容", icon: Layers },
  { key: "image", label: "图片", icon: ImageIcon },
  { key: "video", label: "视频", icon: Video },
  { key: "text", label: "文字", icon: FileText },
  { key: "canvas", label: "关系画布", icon: Network },
  { key: "trash", label: "回收站", icon: Trash2 },
];

export default function WikiSidebar({ activeTab, onChooseTab, busy, readOnly = false, children }) {
  const [utilitiesOpen, setUtilitiesOpen] = useState(false);
  return <aside className="wiki-sidebar" aria-label="内容导航" data-utilities-open={utilitiesOpen}>
    <a className="workspace-brand" href={readOnly ? "#wiki" : "#agent"}><img className="workspace-brand-mark" src="./brand/self-wiki-64.png" width="32" height="32" alt="" /><strong>self-wiki</strong></a>
    {!readOnly && <button className="wiki-utilities-toggle" aria-label="更多工具" aria-expanded={utilitiesOpen} onClick={() => setUtilitiesOpen((current) => !current)}><MoreHorizontal size={18} /><span>更多</span></button>}
    {!readOnly && <a className="wiki-agent-entry" href="#agent" aria-label="Wiki Agent" aria-current={activeTab === "agent" ? "page" : undefined} aria-disabled={busy} onClick={(e) => { if (busy) e.preventDefault(); }}><MessageCircle size={19} /><span><strong>Wiki Agent</strong></span></a>}
    <div className="wiki-sidebar-heading">内容库</div>
    {wikiSections.filter((entry) => !readOnly || entry.key !== "trash").map(({ key, label, icon: Icon }) => <button key={key} className={activeTab === key ? "active" : ""} onClick={() => onChooseTab(key)} disabled={busy} aria-current={activeTab === key ? "page" : undefined}><Icon size={18} /><span>{label}</span></button>)}
    {children}
  </aside>;
}
