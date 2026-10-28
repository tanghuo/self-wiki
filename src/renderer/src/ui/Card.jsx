// Cards and side-panel blocks: a 16px section title with at most one text action on the right.
export default function Card({ title, count, icon: Icon, action, as: Tag = "section", headingLevel = 2, className = "", children, ...props }) {
  const Heading = `h${headingLevel}`;
  return <Tag className={`ui-card ${className}`.trim()} {...props}>
    {(title || action) && <header className="ui-card-header">
      {title && <Heading className="ui-card-title">{Icon && <Icon size={16} aria-hidden="true" />}{title}{count !== undefined && count !== null && <span>{count}</span>}</Heading>}
      {action}
    </header>}
    {children}
  </Tag>;
}
