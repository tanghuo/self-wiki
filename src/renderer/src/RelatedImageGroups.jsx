import { Tag } from "lucide-react";
import { apiUrl } from "./api.js";
import { groupRelatedImages } from "./groupRelatedImages.js";

export default function RelatedImageGroups({ relations = [], renderRelation, paged }) {
  return groupRelatedImages(relations).map((group) => {
    if (!group.tag) return renderRelation(group.relations[0]);
    const images = [...new Map(group.relations.map(({ element }) => [element.id, element])).values()];
    return <details className="wiki-related-tag-group" key={`tag:${group.tag}`}>
      <summary className="wiki-card wiki-tag-card">
        <div className="wiki-tag-cover" data-count={Math.min(images.length, 4)} aria-hidden="true">
          {images.slice(0, 4).map((element) => <img key={element.id} src={apiUrl(`/api/elements/${element.id}/thumbnail`)} alt="" loading="lazy" />)}
        </div>
        <div className="wiki-tag-card-info">
          <strong><Tag size={16} /><span>#{group.tag}</span></strong>
          <div><span>{paged ? "本页 " : ""}{images.length} 张关联图片</span><span className="wiki-group-expand">展开查看</span><span className="wiki-group-collapse">收起</span></div>
        </div>
      </summary>
      <div className="wiki-grid wiki-related-grid">{group.relations.map(renderRelation)}</div>
    </details>;
  });
}
