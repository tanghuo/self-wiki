import { DialogFrame } from "./ui/ConfirmDialog.jsx";
import { shortcutGroups } from "./shortcuts.js";

export default function KeyboardShortcuts({ onClose }) {
  return <DialogFrame bare title="键盘快捷键" description={<>在输入框外按 <kbd>?</kbd> 可随时打开此列表。</>} className="wiki-dialog shortcuts-dialog" closeLabel="关闭快捷键列表" onClose={onClose}>
    <div className="shortcuts-body">
      {shortcutGroups.map((group) => <section key={group.title} aria-label={group.title}>
        <h3>{group.title}</h3>
        <dl>{group.items.map(([keys, description]) => <div key={description}>
          <dt>{keys.map((key, index) => <kbd key={index}>{key}</kbd>)}</dt><dd>{description}</dd>
        </div>)}</dl>
      </section>)}
    </div>
  </DialogFrame>;
}
