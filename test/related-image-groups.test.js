import { test } from "node:test";
import assert from "node:assert/strict";
import { groupRelatedImages } from "../src/renderer/src/groupRelatedImages.js";

test("overlapping tags group images once while preserving untagged, text and dynamic relations", () => {
  const relations = [
    { id: 1, element: { id: 1, kind: "image", tags: ["角色", "海边"] } },
    { id: 2, element: { id: 2, kind: "image", tags: ["角色", "海边"] } },
    { id: 3, element: { id: 3, kind: "image", tags: ["角色"] } },
    { id: 4, element: { id: 4, kind: "image", tags: [] } },
    { id: 5, element: { id: 5, kind: "text", tags: ["角色"] } },
    { id: 6, tagRelationId: 9, element: { id: 6, kind: "image", tags: ["角色"] } },
  ];
  const groups = groupRelatedImages(relations);
  assert.equal(groups[0].tag, "角色");
  assert.deepEqual(groups[0].relations, relations.slice(0, 3));
  assert.deepEqual(groups.flatMap((group) => group.relations), relations);
  assert.ok(groups.slice(1).every((group) => !group.tag));
  assert.deepEqual(groupRelatedImages([]), []);
});

test("multiple relationships to a single image do not create an image group", () => {
  const element = { id: 1, kind: "image", tags: ["角色"] };
  assert.equal(groupRelatedImages([{ id: 1, element }, { id: 2, element }]).length, 2);
});
