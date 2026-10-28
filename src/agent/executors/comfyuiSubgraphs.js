import { elementError } from '../../shared/domain/elements.js';

function graphLinks(graph) {
  if (!Array.isArray(graph.links)) throw elementError('ComfyUI 子图连线无效');
  const result = new Map();
  for (const entry of graph.links) {
    const [id, origin, slot, target, targetSlot, type] = Array.isArray(entry) ? entry : [entry.id, entry.origin_id, entry.origin_slot, entry.target_id, entry.target_slot, entry.type];
    if (result.has(String(id)) || !Number.isInteger(slot) || slot < 0 || !Number.isInteger(targetSlot) || targetSlot < 0) throw elementError('ComfyUI 子图连线无效');
    result.set(String(id), { origin: String(origin), slot, target: String(target), targetSlot, type });
  }
  return result;
}

// Resolve boundaries in memory. Definition nodes belong to an instance, so two
// uses of the same definition must never share node IDs or widget overrides.
export function expandComfyuiSubgraphs(value) {
  if (!Array.isArray(value?.nodes) || !value.definitions?.subgraphs?.length) return { value, overrides: new Map() };
  const definitions = new Map(), contexts = [], overrides = new Map();
  function register(graph) {
    for (const definition of graph.definitions?.subgraphs || []) {
      if (definitions.has(definition.id)) throw elementError('ComfyUI 子图定义 ID 重复');
      definitions.set(definition.id, definition);
      register(definition);
    }
  }
  register(value);
  let count = 0;
  function context(graph, prefix = '', parent = null, host = null, ancestry = []) {
    if (!Array.isArray(graph.nodes) || ancestry.length > 16) throw elementError('ComfyUI 子图无效或嵌套过深');
    const ctx = { graph, prefix, parent, host, nodes: new Map(), links: graphLinks(graph), children: new Map(), values: new Map() };
    contexts.push(ctx);
    for (const node of graph.nodes) {
      const id = String(node.id);
      if (!/^[\w.:-]{1,128}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || ctx.nodes.has(id)) throw elementError('ComfyUI 子图节点 ID 无效或重复');
      if (++count > 1000 || (prefix + id).length > 128) throw elementError('ComfyUI 子图展开后最多 1000 个节点，节点 ID 最多 128 字符');
      ctx.nodes.set(id, node);
      const definition = definitions.get(node.type);
      if (!definition || node.mode === 2 || node.mode === 4) continue;
      if (ancestry.includes(node.type)) throw elementError('ComfyUI 子图存在递归引用');
      const child = context(definition, `${prefix}${id}:`, ctx, node, [...ancestry, node.type]);
      ctx.children.set(id, child);
      const widgets = node.widgets_values || [];
      if (!Array.isArray(widgets)) throw elementError('ComfyUI 子图控件存储格式无效');
      const proxies = node.properties?.proxyWidgets;
      if (Array.isArray(proxies) && proxies.length && !node.widgets_values_named) {
        if (widgets.length && widgets.length !== proxies.length) throw elementError(`ComfyUI 子图 ${id} 的代理控件数量不符`);
        proxies.forEach((proxy, index) => {
          if (!Array.isArray(proxy) || proxy.length !== 2 || !child.nodes.has(String(proxy[0]))) throw elementError(`ComfyUI 子图 ${id} 的代理控件来源无效`);
          const [target, name] = proxy, value = widgets[index];
          if (value == null) return;
          const field = name === 'control_after_generate' ? `${proxies.slice(0, index).findLast((entry) => String(entry[0]) === String(target) && ['seed', 'noise_seed'].includes(entry[1]))?.[1] || 'seed'}:control_after_generate` : name;
          const nested = child.children.get(String(target));
          if (nested) nested.values.set(field, value);
          else {
            const targetId = child.prefix + target;
            if (!overrides.has(targetId)) overrides.set(targetId, new Map());
            overrides.get(targetId).set(field, value);
          }
        });
        continue;
      }
      let index = 0;
      for (const input of node.inputs || []) {
        if (!input.widget) continue;
        if (node.widgets_values_named) {
          if (!Object.hasOwn(node.widgets_values_named, input.name)) throw elementError(`ComfyUI 子图 ${id} 缺少命名控件 ${input.name}`);
          child.values.set(input.name, node.widgets_values_named[input.name]);
          if (['seed', 'noise_seed'].includes(input.widget.name) && node.widgets_values_named.control_after_generate) child.values.set(`${input.name}:control_after_generate`, node.widgets_values_named.control_after_generate);
        } else if (index < widgets.length) child.values.set(input.name, widgets[index++]);
        // Seed control widgets may be saved alongside the promoted value.
        if (['seed', 'noise_seed'].includes(input.widget.name) && ['fixed', 'increment', 'decrement', 'randomize'].includes(widgets[index])) child.values.set(`${input.name}:control_after_generate`, widgets[index++]);
      }
      if (!node.widgets_values_named && index !== widgets.length) throw elementError(`ComfyUI 子图 ${id} 存在尚不支持的控件序列化`);
      if (definition.widgets?.length) throw elementError(`ComfyUI 子图 ${id} 使用尚不支持的暴露控件格式`);
    }
    return ctx;
  }
  const root = context(value);
  function incoming(ctx, linkId, target, slot, seen) {
    const key = `${ctx.prefix}link:${linkId}`;
    if (seen.has(key)) throw elementError('ComfyUI 子图边界存在循环连线');
    const next = new Set(seen); next.add(key);
    const link = ctx.links.get(String(linkId));
    if (!link || link.target !== String(target) || link.targetSlot !== slot) throw elementError('ComfyUI 子图边界连线不完整');
    return source(ctx, link.origin, link.slot, next);
  }
  function source(ctx, id, slot, seen) {
    if (ctx.parent && id === String(ctx.graph.inputNode?.id)) {
      const boundary = ctx.graph.inputs?.[slot];
      if (!boundary) throw elementError('ComfyUI 子图输入插槽无效');
      const hostSlot = ctx.host.inputs?.findIndex((input) => input.name === boundary.name) ?? -1;
      const input = ctx.host.inputs?.[hostSlot];
      if (!input) throw elementError(`ComfyUI 子图缺少外部输入 ${boundary.name}`);
      if (input.link != null) return incoming(ctx.parent, input.link, ctx.host.id, hostSlot, seen);
      return ctx.values.has(input.name) && ctx.values.get(input.name) != null ? { value: ctx.values.get(input.name), control: ctx.values.get(`${input.name}:control_after_generate`) } : null;
    }
    const node = ctx.nodes.get(id);
    if (!node) throw elementError('ComfyUI 子图连线来源不存在');
    if (node.mode === 2) return null;
    if (node.type === 'Reroute' && node.mode !== 4) {
      if (node.inputs?.[0]?.link == null) throw elementError('ComfyUI 子图转接节点缺少输入');
      return incoming(ctx, node.inputs[0].link, id, 0, seen);
    }
    const child = ctx.children.get(id);
    if (!child) return { nodeId: ctx.prefix + id, slot };
    if (!child.graph.outputs?.[slot]) throw elementError('ComfyUI 子图输出插槽无效');
    const outputLinks = [...child.links.entries()].filter(([, link]) => link.target === String(child.graph.outputNode?.id) && link.targetSlot === slot);
    if (outputLinks.length !== 1) throw elementError('ComfyUI 子图输出缺少唯一的内部连线');
    return incoming(child, outputLinks[0][0], child.graph.outputNode.id, slot, seen);
  }
  const nodes = [], links = [];
  for (const ctx of contexts) for (const [id, node] of ctx.nodes) {
    if (ctx.children.has(id)) continue;
    const copy = structuredClone(node); copy.id = ctx.prefix + id;
    copy.inputs = (node.inputs || []).map((input, slot) => {
      if (input.link == null) return { ...input };
      const resolved = incoming(ctx, input.link, id, slot, new Set());
      if (!resolved) return { ...input, link: null };
      if (Object.hasOwn(resolved, 'value')) {
        if (!overrides.has(copy.id)) overrides.set(copy.id, new Map());
        overrides.get(copy.id).set(input.name, resolved.value);
        if (resolved.control) overrides.get(copy.id).set(`${input.name}:control_after_generate`, resolved.control);
        return { ...input, link: null };
      }
      const linkId = links.length + 1;
      links.push([linkId, resolved.nodeId, resolved.slot, copy.id, slot, input.type]);
      return { ...input, link: linkId };
    });
    nodes.push(copy);
  }
  return { value: { ...root.graph, nodes, links }, overrides };
}
