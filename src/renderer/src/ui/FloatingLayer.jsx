// The floating tool layer of a browsing surface (library, trash, canvas): title and search on top,
// page actions top-right, filters in one capsule at the bottom. It is a real layout layer inside
// the page column, so it follows the column's width when the Agent dock opens or the window
// narrows; nothing is positioned against the viewport.
// mode="sticky": the page scrolls and the bars stick to the column's top and bottom edges.
// mode="overlay": the content has its own fixed-height stage (canvas) and the bars float over it.
export default function FloatingLayer({ title, subtitle, search, actions, filters, filtersLabel = "筛选与视图", mode = "sticky", className = "", headerClassName = "", filtersClassName = "", children }) {
  return <div className={`ui-float-layer is-${mode} ${className}`.trim()}>
    <header className={`ui-float-top ${headerClassName}`.trim()}>
      <div className="ui-float-title">{title}{subtitle && <p className="page-header-sub">{subtitle}</p>}</div>
      <div className="ui-float-search">{search}</div>
      <div className="ui-float-actions page-header-actions">{actions}</div>
    </header>
    <div className="ui-float-content">{children}</div>
    {filters && <div className="ui-float-bottom"><div className={`ui-float-capsule ${filtersClassName}`.trim()} role="toolbar" aria-label={filtersLabel}>{filters}</div></div>}
  </div>;
}
