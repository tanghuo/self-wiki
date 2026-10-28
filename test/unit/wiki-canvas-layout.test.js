import { test } from "node:test";
import assert from "node:assert/strict";
import { relationshipGraph } from "../../src/renderer/src/canvasLayout.js";

const node = (id, kind = "image") => ({ id: String(id), type: "element", position: { x: id * 10, y: 99 }, data: { element: { id, kind, tags: ["参考"] } } });
const edge = (id, source, target, name = "原型图", type = "related") => ({ id: String(id), source: String(source), target: String(target), data: { name, type } });

test("Relationship layout folds only images with identical named neighbors and preserves every relation", () => {
  const nodes = [node(1, "text"), node(2), ...[3, 4, 5, 6, 7, 8].map((id) => node(id)), node(9, "text")];
  const edges = [edge(1, 1, 2), ...[3, 4, 5, 6, 7, 8].flatMap((id) => [edge(id * 2, 1, id), edge(id * 2 + 1, id, 2)])];
  const before = structuredClone({ nodes, edges });
  const folded = relationshipGraph(nodes, edges, new Set(), () => {});
  assert.equal(folded.groups.length, 1);
  assert.equal(folded.groups[0].members.length, 6);
  assert.equal(folded.nodes.length, 4);
  assert.equal(folded.edges.length, 3);
  assert.deepEqual(new Set(folded.edges.flatMap((entry) => entry.data.relationIds || [entry.id])), new Set(edges.map((entry) => entry.id)));
  const open = relationshipGraph(nodes, edges, new Set([folded.groups[0].id]), () => {});
  assert.equal(open.nodes.filter((entry) => entry.type === "element").length, nodes.length);
  assert.deepEqual(open.edges, edges);
  assert.deepEqual({ nodes, edges }, before);
  const frame = open.nodes.find((entry) => entry.type === "cluster");
  for (const member of open.nodes.filter((entry) => folded.membership.has(entry.id))) {
    assert.ok(member.position.x >= frame.position.x && member.position.x + 220 <= frame.position.x + frame.width);
    assert.ok(member.position.y >= frame.position.y + 52 && member.position.y + 216 <= frame.position.y + frame.height);
  }
  // A different name and the direction of a legacy title relation must not be
  // erased by the shared-neighbor grouping heuristic.
  edges[1].data.name = "另一种关联";
  assert.equal(relationshipGraph(nodes, edges, new Set(), () => {}).groups[0].members.length, 5);
  const titles = [3, 4, 5, 6].map((id) => edge(id, id === 6 ? 1 : id, id === 6 ? id : 1, "", "title"));
  assert.equal(relationshipGraph(nodes, titles, new Set(), () => {}).groups.length, 0);
});

test("Relationship layout handles cycles, disconnected nodes and the canvas cap without overlap", () => {
  const nodes = Array.from({ length: 300 }, (_, id) => node(id + 1, "text"));
  const edges = [edge(1, 1, 2), edge(2, 2, 3), edge(3, 3, 1)];
  const result = relationshipGraph(nodes, edges, new Set(), () => {});
  assert.equal(result.nodes.length, 300);
  for (const [index, current] of result.nodes.entries()) {
    assert.ok(Number.isFinite(current.position.x) && Number.isFinite(current.position.y));
    for (const other of result.nodes.slice(index + 1)) {
      assert.ok(Math.abs(current.position.x - other.position.x) >= 220 || Math.abs(current.position.y - other.position.y) >= 216);
    }
  }
  assert.deepEqual(relationshipGraph([], [], new Set(), () => {}).nodes, []);
});
