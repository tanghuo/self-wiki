import { useEffect, useState } from "react";
import { Copy, Info } from "lucide-react";
import { request } from "./api.js";
import { DialogFrame } from "./ui/ConfirmDialog.jsx";

export default function EmbeddedPrompt({ id }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setData(null);
    setOpen(false);
    setCopied("");
    request(`/api/elements/${id}/embedded-prompt`, { signal: controller.signal }).then(
      (value) => { if (alive) setData(value); },
      () => { if (alive) setData({ found: false }); },
    );
    return () => { alive = false; controller.abort(); };
  }, [id]);

  if (!data?.found) return null;

  function close() {
    setOpen(false);
    setCopied("");
  }

  async function copy(text, key) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
    } catch {
      setCopied(`fail:${key}`);
    }
  }

  return <>
    <div className="wiki-embedded-prompt-entry">
      <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog"><Info size={15} />生成信息</button>
    </div>
    {open && <DialogFrame bare title="生成信息" description={data.sourceLabel} className="wiki-dialog embedded-prompt-dialog" closeLabel="关闭生成信息" onClose={close}>
      <div className="embedded-prompt-body">
        {data.sections.map((section, index) => <section className="embedded-prompt-section" key={`${section.title}:${index}`}>
          <header>
            <h3>{section.title}</h3>
            <button type="button" className="text-button" onClick={() => copy(section.text, String(index))}><Copy size={14} />{copied === String(index) ? "已复制" : copied === `fail:${index}` ? "复制失败" : "复制"}</button>
          </header>
          <pre>{section.text}</pre>
        </section>)}
        {data.parameters.length > 0 && <dl className="embedded-prompt-parameters">
          {data.parameters.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}
        </dl>}
        {data.hasWorkflow && <p className="wiki-muted">此文件还包含可拖回 ComfyUI 的工作流。</p>}
        {data.raw && <details className="embedded-prompt-raw">
          <summary>原始 prompt</summary>
          <pre>{data.raw}</pre>
          {data.rawTruncated && <p className="wiki-muted">原文过长，这里只显示前面一部分。</p>}
        </details>}
      </div>
    </DialogFrame>}
  </>;
}
