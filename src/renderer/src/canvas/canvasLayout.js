// Layers express distance from a connection
// center, never an inferred generation order or a new persisted relationship.
// shelfWidth: how wide a row of components may grow before wrapping; wide stages pass a larger value.
export function relationshipGraph(nodes, edges, expanded, onToggle, shelfWidth = 1500) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const links = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    links.get(edge.source).push(edge);
    links.get(edge.target).push(edge);
  }
  const twins = new Map();
  for (const node of nodes) {
    if (node.data.element.kind !== "image" || !links.get(node.id).length) continue;
    const signature = JSON.stringify(links.get(node.id).map((edge) => [
      edge.source === node.id ? edge.target : edge.source,
      edge.data.type, edge.data.name || "", edge.data.reverseName || "",
      ["forward", "reverse"].includes(edge.data.direction) ? ((edge.data.direction === "forward") === (edge.source === node.id) ? "out" : "in") : edge.data.direction || "symmetric",
      edge.data.type === "title" ? edge.source === node.id : null,
    ]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    if (!twins.has(signature)) twins.set(signature, []);
    twins.get(signature).push(node);
  }
  const groups = [...twins.values()].filter((members) => members.length >= 4).map((members) => {
    members.sort((a, b) => Number(a.id) - Number(b.id));
    const id = `cluster:${members.map((node) => node.id).join("-")}`;
    const open = expanded.has(id);
    const commonTag = members[0].data.element.tags.find((tag) => members.every((node) => node.data.element.tags.includes(tag)));
    const columns = Math.min(6, Math.ceil(Math.sqrt(members.length * 1.5)));
    return { id, members, open, columns, width: open ? columns * 244 + 16 : 320,
      height: open ? Math.ceil(members.length / columns) * 240 + 64 : 248,
      label: commonTag ? `${commonTag} · 关联图片` : "关联图片" };
  });
  const membership = new Map(groups.flatMap((group) => group.members.map((node) => [node.id, group.id])));
  const units = new Map([
    ...nodes.filter((node) => !membership.has(node.id)).map((node) => [node.id, { id: node.id, node, width: 220, height: 216 }]),
    ...groups.map((group) => [group.id, group]),
  ]);
  const neighbors = new Map([...units.keys()].map((id) => [id, new Set()]));
  for (const edge of edges) {
    const source = membership.get(edge.source) || edge.source;
    const target = membership.get(edge.target) || edge.target;
    if (source !== target && neighbors.has(source) && neighbors.has(target)) {
      neighbors.get(source).add(target); neighbors.get(target).add(source);
    }
  }
  // Count distinct content neighbors, so parallel named relations do not turn
  // an otherwise ordinary card into a connection center.
  const degree = (id) => units.get(id).members ? 0 : new Set(links.get(id).map((edge) => edge.source === id ? edge.target : edge.source)).size;
  const remaining = new Set(units.keys());
  const placed = [];
  let shelfX = 0, shelfY = 0, shelfHeight = 0;
  while (remaining.size) {
    const first = remaining.values().next().value;
    const component = [first]; remaining.delete(first);
    for (let index = 0; index < component.length; index++) {
      for (const id of neighbors.get(component[index])) if (remaining.delete(id)) component.push(id);
    }
    component.sort((a, b) => degree(b) - degree(a) || a.localeCompare(b, undefined, { numeric: true }));
    const roots = [component[0]];
    for (const id of component.slice(1)) {
      if (roots.length < 3 && degree(id) >= Math.max(3, degree(roots[0]) * 0.75)) roots.push(id);
    }
    const levels = new Map(roots.map((id) => [id, 0]));
    const queue = [...roots];
    for (let index = 0; index < queue.length; index++) {
      for (const id of neighbors.get(queue[index])) if (!levels.has(id)) {
        levels.set(id, levels.get(queue[index]) + 1); queue.push(id);
      }
    }
    // Short text attached only to the centers can share their column, keeping
    // the image collection from growing taller just to accommodate a note.
    for (const id of component) if (units.get(id).node?.data.element.kind === "text" &&
      neighbors.get(id).size && [...neighbors.get(id)].every((neighbor) => roots.includes(neighbor))) levels.set(id, 0);
    const columns = [];
    for (const id of component) (columns[levels.get(id)] ||= []).push(units.get(id));
    const heights = columns.map((column) => column.reduce((sum, unit) => sum + unit.height + 30, -30));
    const height = Math.max(...heights);
    const width = columns.reduce((sum, column) => sum + Math.max(...column.map((unit) => unit.width)) + 130, -130);
    if (shelfX && shelfX + width > shelfWidth) { shelfX = 0; shelfY += shelfHeight + 100; shelfHeight = 0; }
    let x = shelfX;
    columns.forEach((column, index) => {
      let y = shelfY + (height - heights[index]) / 2;
      for (const unit of column) {
        placed.push({ ...unit, position: { x, y }, hub: degree(unit.id) >= 3 && roots.includes(unit.id), degree: degree(unit.id) });
        y += unit.height + 30;
      }
      x += Math.max(...column.map((unit) => unit.width)) + 130;
    });
    shelfX += width + 100; shelfHeight = Math.max(shelfHeight, height);
  }
  const renderedNodes = placed.flatMap((unit) => {
    if (!unit.members) return [{ ...unit.node, position: unit.position, data: { ...unit.node.data, hub: unit.hub, degree: unit.degree } }];
    const frame = { id: unit.id, type: "cluster", position: unit.position, draggable: false, selectable: false, connectable: false,
      width: unit.width, height: unit.height, measured: { width: unit.width, height: unit.height },
      style: { width: unit.width, height: unit.height }, zIndex: unit.open ? -1 : 0,
      data: { group: unit, onToggle }, ariaLabel: `${unit.label}，${unit.members.length} 张图片` };
    return [frame, ...(unit.open ? unit.members.map((node, index) => ({ ...node,
      position: { x: unit.position.x + 20 + index % unit.columns * 244, y: unit.position.y + 64 + Math.floor(index / unit.columns) * 240 },
      data: { ...node.data, degree: new Set(links.get(node.id).map((edge) => edge.source === node.id ? edge.target : edge.source)).size },
    })) : [])];
  });
  const collapsed = new Set(groups.filter((group) => !group.open).map((group) => group.id));
  const bundles = new Map();
  const renderedEdges = [];
  for (const edge of edges) {
    const source = collapsed.has(membership.get(edge.source)) ? membership.get(edge.source) : edge.source;
    const target = collapsed.has(membership.get(edge.target)) ? membership.get(edge.target) : edge.target;
    if (source === edge.source && target === edge.target) { renderedEdges.push(edge); continue; }
    const endpoints = (edge.data.type === "title" || ["forward", "reverse"].includes(edge.data.direction)) ? [source, target] : [source, target].sort();
    const key = JSON.stringify([...endpoints, edge.data.type, edge.data.name, edge.data.direction, edge.data.reverseName]);
    if (!bundles.has(key)) bundles.set(key, { ...edge, id: `bundle:${edge.id}`, source, target,
      data: { ...edge.data, offset: 0, bundleGroupId: collapsed.has(source) ? source : target, relationIds: [] } });
    bundles.get(key).data.relationIds.push(edge.id);
  }
  for (const edge of bundles.values()) renderedEdges.push({ ...edge, label: `${edge.label || edge.data.name || (edge.data.type === "title" ? "是标题" : "关联")} · ${edge.data.relationIds.length}` });
  return { nodes: renderedNodes, edges: renderedEdges, membership, groups };
}
