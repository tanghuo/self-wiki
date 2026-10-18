import { useEffect, useId, useState } from "react";
import { Info } from "lucide-react";
import { request } from "./api.js";
import { imageExecutors } from "../../shared/domain/imageGeneration.js";
import "./chatTrace.css";

function TraceField({ title, value }) {
  const [copyState, setCopyState] = useState("");
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (value === undefined) return null;
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopyState("已复制"); }
    catch { setCopyState("复制失败，可选中文字复制"); }
  }
  return <section className="chat-trace-field"><header><strong>{title}</strong><button type="button" className="text-button" onClick={copy} aria-label={`复制${title}`}>{copyState || "复制"}</button></header><pre>{text === "" ? "（空字符串）" : text}</pre></section>;
}

function PromptComparison({ before, after }) {
  if (typeof before !== "string" || typeof after !== "string") return null;
  if (before === after) return <p>输入与改写提示词一致。</p>;
  const a = [...before], b = [...after];
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - end - 1] === b[b.length - end - 1]) end++;
  return <details className="chat-trace-comparison"><summary>对比输入与改写提示词</summary><p>标出首处差异到末处差异之间的区段。</p>
    <div><section><strong>输入提示词</strong><pre>{a.slice(0, start).join("")}<del>{a.slice(start, a.length - end).join("")}</del>{end ? a.slice(-end).join("") : ""}</pre></section>
      <section><strong>工具返回的改写提示词</strong><pre>{b.slice(0, start).join("")}<ins>{b.slice(start, b.length - end).join("")}</ins>{end ? b.slice(-end).join("") : ""}</pre></section></div>
  </details>;
}

export function TraceContent({ turnId, eventId, version, running }) {
  const [data, setData] = useState(null), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(""); setData(null);
    request(`/api/chat/turns/${turnId}/trace${eventId === undefined ? "" : `?event=${encodeURIComponent(eventId)}`}`, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setData(value); })
      .catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [turnId, eventId, version, retry, running]);
  if (error) return <p role="alert">记录加载失败：{error}<button type="button" className="text-button" onClick={() => setRetry((n) => n + 1)}>重试加载</button></p>;
  if (!data) return <p role="status">正在读取调用记录…</p>;
  if (!data.record) return <p className="chat-trace-unavailable">{data.status === "deleted" ? "记录已随相关内容删除而清理。" : running ? "当前尚无记录；请求发出或 CLI 返回后会更新。" : "这条历史记录没有保存详情，无法还原当时的实际请求。"}</p>;
  const { value, omissions } = data.record;
  const { prompt, ...parameters } = value.input || {};
  const { revisedPrompt, ...output } = value.output || {};
  const isRequest = value.type === "request";
  const imageExecutor = imageExecutors.find((entry) => entry.id === value.input?.executor);
  const isImageTool = imageExecutor?.mode === "tool";
  return <div className="chat-trace-content">
    {data.status === "legacy" && <p>仅展示历史事件中实际保存的字段，其余调用参数未记录。</p>}
    {isRequest && value.contextMode === "direct-image" ? <>
      <p>本轮原文直发到 {imageExecutors.find((entry) => entry.id === (value.imageExecutor || "chatgpt-web"))?.label}，未调用 AI 改写。文字素材按选择顺序拼接。</p>
      {(!value.imageExecutor || value.imageExecutor === "chatgpt-web") && <p>{value.submission?.confirmed ? "已在 ChatGPT 页面确认收到提示词。" : "尚未确认 ChatGPT 网页收到提示词。"}</p>}
      {value.error && <p>{value.error}</p>}
      <TraceField title="本轮生图选项" value={value.imageOptions} />
      <TraceField title="你的原话" value={value.userText} />
      <TraceField title="实际发送的文本" value={value.input?.prompt} />
      <TraceField title="附件（按发送顺序）" value={value.input?.referencePaths} />
      <details><summary>查看请求 JSON</summary><TraceField title="应用请求记录 JSON" value={data.record} /></details>
    </> : isRequest ? <>
      <p>{value.contextMode === "resumed" ? "本轮续接已有 CLI 会话。下方是本轮新增请求；CLI 内部保留的上下文未在此完整展开。" : "下方是应用当时提交的请求，包含实际补入的历史和参考资料。"} CLI 自身的内部指令不在记录范围内。</p>
      {value.originTurnId !== turnId && <p>此记录复制自原会话，保留了原请求中的标识。</p>}
      <p>模型：{value.turn?.params?.model || value.thread?.params?.model} · 努力等级：{value.turn?.params?.effort || "默认"}</p>
      <p>请求状态：{({ attempted: "已尝试发送，尚未确认", acknowledged: "CLI 已确认接收", unknown: "响应失败，是否接收未知" })[(value.turn || value.thread)?.delivery]}{value.error ? ` · ${value.error}` : ""}</p>
      <TraceField title="你的原话" value={value.userText} />
      <TraceField title="实际发送的文本" value={value.turn?.params?.input?.find((item) => item.type === "text")?.text} />
      <TraceField title="应用附加指令" value={value.thread?.params?.developerInstructions} />
      <TraceField title="附件（按发送顺序）" value={value.turn?.params?.input?.filter((item) => item.type !== "text")} />
      <details><summary>查看请求 JSON</summary><TraceField title="应用请求记录 JSON" value={data.record} /></details>
    </> : <>
      <p>记录来源：{value.observedVia}。未返回的参数和输出无法还原。</p>
      {value.type === "imageGeneration" && <>
        {prompt === undefined ? <p>原始提示词：{isImageTool ? "执行器" : "CLI"} 未返回。</p> : <TraceField title={isImageTool ? `输入提示词（${imageExecutor.label}）` : "输入提示词（CLI 记录）"} value={prompt} />}
        {isImageTool ? <TraceField title="准备提交的完整提示词" value={value.preparedPrompt} />
          : revisedPrompt === undefined ? <p>改写提示词：CLI 未返回。</p> : <TraceField title="工具返回的改写提示词" value={revisedPrompt} />}
        {!isImageTool && (omissions?.some((note) => note.path === "$.input.prompt" || note.path === "$.output.revisedPrompt")
          ? <p>提示词记录不完整，无法完整比较。</p> : <PromptComparison before={prompt} after={revisedPrompt} />)}
      </>}
      {(value.type !== "imageGeneration" || Object.keys(parameters).length > 0) && <TraceField title="调用参数" value={value.type === "imageGeneration" ? parameters : value.input} />}
      <TraceField title="进程输出" value={value.execution} />
      <TraceField title="执行进度" value={value.progress} />
      <TraceField title="ComfyUI 任务" value={value.comfyui} />
      {value.submission?.confirmed && <p>执行器已确认收到请求。</p>}
      {value.output === undefined || !Object.keys(output).length ? <p>工具输出：{running ? "尚未返回。" : isImageTool ? "执行器未返回。" : "CLI 未返回。"}</p> : <TraceField title="工具输出" value={output} />}
      <details><summary>查看记录 JSON</summary><TraceField title="工具记录 JSON" value={data.record} /></details>
    </>}
    {omissions?.length > 0 && <details className="chat-trace-omissions" open><summary>记录中有省略或隐藏的内容</summary><ul>{omissions.map((note, index) => <li key={index}><code>{note.path}</code>：{note.reason}{note.originalChars !== undefined && `（原 ${note.originalChars} 字符，保存 ${note.savedChars} 字符）`}</li>)}</ul></details>}
  </div>;
}

export function ToolTrace({ turnId, eventId, version, command, state, error, progress }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  return <div className="chat-tool-trace">
    <div className="chat-tool-heading"><code>{command}</code><span>{state === "running" ? progress || "进行中" : ({ completed: "完成", failed: "失败" })[state]}</span>
      <button type="button" className="text-button chat-tool-trace-toggle" aria-label={open ? "收起详情" : "查看详情"} title={open ? "收起详情" : "查看详情"} aria-expanded={open} aria-controls={contentId} onClick={() => setOpen((value) => !value)}><Info size={14} /></button>
    </div>
    {error && <small>{error}</small>}
    {open && <div id={contentId}><TraceContent turnId={turnId} eventId={eventId} version={version} running={state === "running"} /></div>}
  </div>;
}

export default function RequestTrace({ turnId, version, running }) {
  const [open, setOpen] = useState(false);
  return <details className="chat-request-trace" onToggle={(e) => { if (e.target === e.currentTarget) setOpen(e.currentTarget.open); }}><summary>查看本轮请求</summary>
    {open && <TraceContent turnId={turnId} version={version} running={running} />}
  </details>;
}
