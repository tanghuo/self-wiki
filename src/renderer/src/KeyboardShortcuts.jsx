import { X } from "lucide-react";
import Dialog from "./Dialog.jsx";
import { shortcutGroups } from "./shortcuts.js";

export default function KeyboardShortcuts({ onClose }) {
  return <Dialog open label="键盘快捷键" className="wiki-dialog shortcuts-dialog" onClose={onClose}>
    <header className="wiki-dialog-header"><div><h2>键盘快捷键</h2><p className="wiki-muted">在输入框外按 <kbd>?</kbd> 可随时打开此列表。</p></div>
      <button className="icon-only" aria-label="关闭快捷键列表" onClick={onClose}><X size={18} /></button></header>
    <div className="shortcuts-body">
      {shortcutGroups.map((group) => <section key={group.title} aria-label={group.title}>
        <h3>{group.title}</h3>
        <dl>{group.items.map(([keys, description]) => <div key={description}>
          <dt>{keys.map((key, index) => <kbd key={index}>{key}</kbd>)}</dt><dd>{description}</dd>
        </div>)}</dl>
      </section>)}
    </div>
  </Dialog>;
}
