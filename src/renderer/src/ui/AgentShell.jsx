// The one skeleton every Agent surface uses (Agent 对话, Agent 工作台, AionUi):
// left = session list (the only place to switch sessions), centre = timeline, right = preview /
// resource panel, always present. Pages fill the slots; the columns never rearrange by content.
// On phones (≤900px) the resource column folds away; `resourcesOpen` brings it back as a sheet over the timeline.
export default function AgentShell({ className = "", resourcesOpen = false, sessions, sessionsLabel = "会话列表", sessionsClassName = "", header, children, timelineClassName = "", resources, resourcesLabel = "资源", resourcesClassName = "" }) {
  return <div className={`agent-shell ${resourcesOpen ? "is-resources-open" : ""} ${className}`.replace(/\s+/g, " ").trim()}>
    <nav className={`agent-shell-sessions ${sessionsClassName}`.trim()} aria-label={sessionsLabel}>{sessions}</nav>
    <div className={`agent-shell-timeline ${timelineClassName}`.trim()}>{header}{children}</div>
    <aside className={`agent-shell-resources ${resourcesClassName}`.trim()} aria-label={resourcesLabel}>{resources}</aside>
  </div>;
}
