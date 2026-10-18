import { sourceRelationRoles } from "../../shared/domain/relationRoles.js";
import { groupRelatedImages } from "./groupRelatedImages.js";
import RelatedImageGroups from "./RelatedImageGroups.jsx";

export default function RelatedContent({ relations = [], paged, renderRelation, tagCards, hasTagRelations }) {
  const sources = [], referencedBy = [], matches = [], remaining = [];
  for (const relation of relations) {
    if (sourceRelationRoles.includes(relation.role)) sources.push(relation);
    else if (relation.role === "referencedBy") referencedBy.push(relation);
    else if (relation.role === "match") matches.push(relation);
    else remaining.push(relation);
  }
  sources.sort((a, b) => sourceRelationRoles.indexOf(a.role) - sourceRelationRoles.indexOf(b.role));
  const groups = groupRelatedImages(remaining);
  const tagged = groups.filter((group) => group.tag).flatMap((group) => group.relations);
  const other = groups.filter((group) => !group.tag).flatMap((group) => group.relations);
  const sections = [
    { title: "创作来源", hint: "提示词、参考素材与来源会话", items: sources, className: "is-sources" },
    { title: "被参考", hint: "以下内容使用了当前内容作为参考", items: referencedBy },
    { title: "可能相关", hint: "提示词匹配与相似内容", items: matches },
    { title: "其他关联", hint: "与当前内容的其他连接", items: other },
  ];
  return <div className="wiki-related-sections">
    {sections.filter(({ items }) => items.length).map(({ title, hint, items, className = "" }) => <section className={`wiki-related-section ${className}`} aria-label={title} key={title}>
      <header><h3>{title}<span>{paged ? "本页 " : ""}{items.length}</span></h3><p>{hint}</p></header>
      <div className="wiki-related-list">{items.map(renderRelation)}</div>
    </section>)}
    {(tagged.length > 0 || hasTagRelations) && <section className="wiki-related-section is-tags" aria-label="同标签内容">
      <header><h3>同标签内容</h3><p>按标签收起的关联内容，展开查看</p></header>
      <div className="wiki-related-list">{tagCards}<RelatedImageGroups relations={tagged} paged={paged} renderRelation={renderRelation} /></div>
    </section>}
  </div>;
}
