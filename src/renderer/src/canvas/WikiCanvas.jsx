import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, ConnectionMode, MarkerType, useNodesState } from "@xyflow/react";
import { Network, Search, Plus, RefreshCw, Maximize2, Save, LayoutGrid, Folders, ChevronRight, ArrowLeft } from "lucide-react";
import { request } from "../api.js";
import useWikiResource from "../useWikiResource.js";
import CanvasNode, { canvasTitle } from "./CanvasNode.jsx";
import RelationPicker from "../RelationPicker.jsx";
import RelationRenameDialog from "../RelationRenameDialog.jsx";
import CanvasEdge from "./CanvasEdge.jsx";
import CanvasTagNode from "./CanvasTagNode.jsx";
import CanvasInspector from "./CanvasInspector.jsx";
import CanvasClusterNode from "./CanvasClusterNode.jsx";
import { relationshipGraph } from "./canvasLayout.js";
import { maxCanvasNodes, maxCanvasEdges, canvasBatchSize } from "../../../shared/domain/canvas.js";
import { elementLabel, relationLabel } from "../../../shared/domain/elements.js";
import "@xyflow/react/dist/style.css";
import FloatingLayer from "../ui/FloatingLayer.jsx";
import { Button } from "../ui/Button.jsx";
import "./canvas.css";
import Select from "../Select.jsx";

const nodeTypes = { element: CanvasNode, tag: CanvasTagNode, cluster: CanvasClusterNode };
const edgeTypes = { relation: CanvasEdge };
const defaultEdgeOptions = { type: "relation", interactionWidth: 24, style: { stroke: "var(--edge)", strokeWidth: 1.6 } };
const nodeExtent = [[-1_000_000, -1_000_000], [1_000_000, 1_000_000]];
const ariaLabelConfig = { "controls.zoomIn.ariaLabel": "放大", "controls.zoomOut.ariaLabel": "缩小", "controls.fitView.ariaLabel": "适应画面", "minimap.ariaLabel": "画布导航图" };

// New cards fill a grid shaped like the stage (aspect = width / height), so fitting the view keeps them readable.
function placeNodes(elements, groups, previous, onSelect, onOpen, aspect = 1.5) {
  const byId = new Map(previous.map((node) => [node.id, node]));
  const items = [
    ...groups.map((group) => ({ id: `tag:${group.id}`, type: "tag", connectable: false, ariaLabel: `标签：${group.name}`, data: { group, onOpen } })),
    ...elements.map((element) => ({ id: String(element.id), type: "element", position: element.position, dragHandle: ".canvas-node-grip", ariaLabel: `内容：${canvasTitle(element)}`, data: { element, onSelect } })),
  ];
  const occupied = items.map((item) => byId.get(item.id)?.position || item.position).filter(Boolean);
  const columns = Math.max(2, Math.ceil(Math.sqrt(items.length * Math.min(3, Math.max(0.6, aspect)) * 260 / 280)));
  let slot = 0;
  return items.map((item) => {
    let position = byId.get(item.id)?.position || item.position;
    if (!position) {
      do { position = { x: slot % columns * 280, y: Math.floor(slot / columns) * 260 }; slot++; }
      while (occupied.some((point) => Math.abs(point.x - position.x) < 250 && Math.abs(point.y - position.y) < 240));
      occupied.push(position);
    }
    return { ...item, position, measured: byId.get(item.id)?.measured };
  });
}

export default function WikiCanvas({ readOnly, revision, addedIds, externalBusy = false, visible = true, onChanged, onBusyChange, onAdd, onOpen, headerActions, quietAdd = false }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [viewport, setViewport] = useState(null);
  const [edges, setEdges] = useState([]);
  const [selected, setSelected] = useState(null);
  const [edgeId, setEdgeId] = useState(null);
  const [connection, setConnection] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [filters, setFilters] = useState({ q: "", tag: "" });
  const [view, setView] = useState(() => {
    try {
      const saved = localStorage.getItem("wikiCanvasArrangement");
      return ["relations", "flat", "tags"].includes(saved) ? saved : localStorage.getItem("wikiCanvasView") === "tags" ? "tags" : "relations";
    } catch { return "relations"; }
  });
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const [showAllEdges, setShowAllEdges] = useState(false);
  const [totals, setTotals] = useState(null);
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(true);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [edgesTruncated, setEdgesTruncated] = useState(false);
  const [layoutDraft, setLayoutDraft] = useState(null);
  const [lastDeleted, setLastDeleted] = useState(null);
  const [detailRevision, setDetailRevision] = useState(0);
  const tags = useWikiResource("/api/tags", revision + detailRevision);
  useEffect(() => {
    const canonical = tags.data?.aliases?.find((a) => a.alias.toLowerCase() === tag.toLowerCase())?.name;
    if (canonical && canonical !== tag) changeTag(canonical);
  }, [tags.data]);
  const current = useRef(null);
  const flow = useRef(null);
  const stage = useRef(null);
  const controller = useRef(null);
  const writeLock = useRef(false);
  const mounted = useRef(true);
  const previousAdded = useRef(null);
  const skipExternalReload = useRef(false);
  const overviewSnapshot = useRef(null);
  const pendingNavigation = useRef(null);
  const select = useCallback((id) => {
    const group = current.current.graph?.membership?.get(id);
    if (group) setExpandedGroups((previous) => new Set(previous).add(group));
    setSelected(id); setEdgeId(null);
  }, []);
  const toggleGroup = useCallback((id) => {
    if (!current.current.canInteract) return;
    setExpandedGroups((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
    setSelected(null); setEdgeId(null);
  }, []);
  const ownBusy = busy || Boolean(layoutDraft) || modal || Boolean(connection) || Boolean(renaming);
  const blocked = ownBusy || externalBusy;
  const canInteract = !blocked && !loading && !stale;
  const isOverview = view === "tags" && !filters.tag;
  // Shape the relation layout like the stage so the default fit fills it with readable cards.
  const [stageAspect, setStageAspect] = useState(1.6);
  useEffect(() => {
    const element = stage.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (element.clientHeight > 0) setStageAspect(Math.round(Math.min(3, Math.max(0.6, element.clientWidth / element.clientHeight)) * 4) / 4);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const shelfWidth = Math.max(1100, Math.min(3200, Math.round(stageAspect * 1000)));
  const graph = useMemo(() => view === "relations" ? relationshipGraph(nodes.filter((node) => node.type === "element"), edges, expandedGroups, toggleGroup, shelfWidth) : { nodes, edges }, [nodes, edges, view, expandedGroups, toggleGroup, shelfWidth]);
  const focusedEdge = edges.find((edge) => edge.id === edgeId);
  const focusIds = new Set(selected ? [selected] : focusedEdge ? [focusedEdge.source, focusedEdge.target] : []);
  for (const edge of edges) if (selected && (edge.source === selected || edge.target === selected)) { focusIds.add(edge.source); focusIds.add(edge.target); }
  const focusing = focusIds.size > 0;
  const visibleFocus = (id) => focusIds.has(id) || graph.groups?.some((group) => group.id === id && group.members.some((node) => focusIds.has(node.id)));
  // Keep the controlled node identities while React Flow is reporting its first measurements.
  const displayNodes = useMemo(() => graph.nodes.map((node) => ({ ...node, selected: node.id === selected,
    className: `${node.data.hub ? "is-hub" : ""} ${focusing && !visibleFocus(node.id) ? "is-muted" : ""}` })), [graph, selected, edgeId]);
  const positions = new Map(graph.nodes.map((node) => [node.id, node.position]));
  const focusedRelations = new Set(selected ? edges.filter((edge) => edge.source === selected || edge.target === selected).map((edge) => edge.id) : []);
  const displayEdges = graph.edges.map((edge) => {
    const source = positions.get(edge.source), target = positions.get(edge.target);
    const highlighted = edge.id === edgeId || focusedRelations.has(edge.id) || edge.data.relationIds?.some((id) => focusedRelations.has(id));
    return { ...edge, sourceHandle: source?.x > target?.x ? "left" : "right", targetHandle: source?.x >= target?.x ? "right" : "left",
      data: { ...edge.data, onRename: readOnly ? undefined : () => renameEdge(edge), renameDisabled: !canInteract },
      selected: edge.id === edgeId, className: `${highlighted ? "is-highlighted" : ""} ${showAllEdges || edge.data.bundleGroupId ? "show-label" : ""}`,
      zIndex: highlighted ? 2 : 0,
      style: { ...defaultEdgeOptions.style, ...edge.style, opacity: highlighted ? 1 : focusing ? 0.12 : showAllEdges ? 0.95 : 0.7, strokeWidth: highlighted ? 2.4 : 1.6 },
    };
  });
  current.current = { nodes, displayNodes, graph, filters, view, canInteract };
  useEffect(() => { try { localStorage.setItem("wikiCanvasArrangement", view); } catch { /* A restricted browser may disable preferences. */ } }, [view]);
  const lastFitView = useRef(null);
  useEffect(() => {
    const key = JSON.stringify([view, [...expandedGroups]]);
    if (lastFitView.current === key) return;
    lastFitView.current = key;
    if (current.current.displayNodes.some((node) => node.selected)) return;
    const timer = setTimeout(() => flow.current?.fitView({ padding: 0.1, maxZoom: 1, duration: 200 }), 100);
    return () => clearTimeout(timer);
  }, [view, expandedGroups]);
  const openGroup = useCallback((group) => {
    if (!current.current.canInteract) return;
    overviewSnapshot.current = { nodes: current.current.nodes, viewport: flow.current?.getViewport(), q: current.current.filters.q };
    setSelected(null); setEdgeId(null); setStale(true);
    setTag(group.name); setFilters({ ...current.current.filters, tag: group.name });
  }, []);
  useEffect(() => { onBusyChange(ownBusy); return () => onBusyChange(false); }, [ownBusy, onBusyChange]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);
  const lastCenteredSelection = useRef(null);
  useEffect(() => {
    if (lastCenteredSelection.current === selected) return;
    lastCenteredSelection.current = selected;
    if (!selected) return;
    const timer = setTimeout(() => {
      const node = current.current.displayNodes.find((entry) => entry.id === selected);
      if (node && flow.current && stage.current.clientHeight > 0) {
        const covered = window.innerWidth <= 720 ? stage.current.clientHeight * 0.57 : 0;
        const zoom = flow.current.getZoom();
        flow.current.setCenter(node.position.x + 110, node.position.y + 107 + covered / (2 * zoom), { zoom, duration: 180 });
      }
    }, 500); // Keep the card under the pointer while a double-click can still complete.
    return () => clearTimeout(timer);
  }, [selected]);
  useEffect(() => {
    if (!blocked) return;
    const warn = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [blocked]);

  const load = useCallback(async ({ reset = false, limit = 0, expand, include, exclude, snapshot } = {}) => {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setLoading(true); setError("");
    const previous = snapshot?.nodes || (reset ? [] : current.current.nodes);
    if (reset) { setNodes([]); setEdges([]); setSelected(null); setEdgeId(null); }
    const groupIds = previous.filter((node) => node.type === "tag").map((node) => node.data.group.id);
    let ids = previous.filter((node) => node.type === "element").map((node) => node.id);
    if (include?.length) ids = groupIds.length === maxCanvasNodes ? [] : [...new Set([...ids, ...include.map(String)])].slice(-(maxCanvasNodes - groupIds.length));
    if (exclude) ids = ids.filter((id) => id !== String(exclude));
    const params = new URLSearchParams({ ...current.current.filters, view: current.current.view === "relations" ? "flat" : current.current.view, groupIds: groupIds.join(","), ids: ids.join(","), limit });
    if (expand) params.set("expand", expand);
    try {
      const result = await request(`/api/canvas?${params}`, { signal: abort.signal });
      if (abort.signal.aborted) return;
      setStale(false);
      setNodes((old) => placeNodes(result.elements, result.groups || [], snapshot?.nodes || (reset ? [] : old), select, openGroup, stage.current?.clientHeight ? stage.current.clientWidth / stage.current.clientHeight : undefined));
      setTotals(result.totals || null);
      const pairCounts = new Map();
      setEdges(result.relations.map((relation) => {
        const pair = [...relation.elementIds].sort((a, b) => a - b).join(":");
        const lane = pairCounts.get(pair) || 0;
        pairCounts.set(pair, lane + 1);
        return { id: String(relation.id), source: String(relation.sourceId), target: String(relation.targetId), data: { ...relation, offset: lane * 65 * (relation.sourceId < relation.targetId ? 1 : -1) },
        label: relation.type === "title" ? relation.name || "是标题" : relation.direction === "unknown" ? relationLabel(relation, relation.sourceId) : relation.name || undefined,
        ...((relation.type === "title" || ["forward", "reverse"].includes(relation.direction)) ? { [relation.direction === "reverse" ? "markerStart" : "markerEnd"]: { type: MarkerType.ArrowClosed, color: "var(--accent)" }, style: { stroke: "var(--accent)", strokeWidth: 1.8 } } : {}) };
      }));
      setHasMore(result.hasMore); setEdgesTruncated(result.edgesTruncated);
      setSelected((value) => result.elements.some((element) => String(element.id) === value) ? value : null);
      setEdgeId((value) => result.relations.some((relation) => String(relation.id) === value) ? value : null);
      if (expand) setMessage(result.expansionHasMore ? "还有关联未展开，可继续展开或缩小展示范围。" : "直接关联已展开。");
      if (reset) {
        setMessage("");
        requestAnimationFrame(() => snapshot?.viewport ? flow.current?.setViewport(snapshot.viewport) : flow.current?.fitView({ padding: 0.1, maxZoom: 1 }));
      }
      if (include?.length === 1 && result.elements.some((element) => element.id === Number(include[0]))) select(String(include[0]));
    } catch (failure) { if (!abort.signal.aborted) { setStale(true); setError(`画布读取失败：${failure.message}`); } }
    finally { if (!abort.signal.aborted) setLoading(false); }
  }, [select, openGroup, setNodes]);

  useEffect(() => {
    if (blocked || (q === filters.q && tag === filters.tag)) return;
    const timeout = setTimeout(() => setFilters({ q, tag }), 300);
    return () => clearTimeout(timeout);
  }, [q, tag, blocked, filters.q, filters.tag]);
  const loadedFilterKey = useRef(null);
  // Content saved after the latest filter edit stays visible even when that edit is applied later
  // (the debounced filter waits while the add dialog is open). A new edit drops the exemption.
  const savedSinceFilterEdit = useRef([]);
  useEffect(() => { savedSinceFilterEdit.current = []; }, [q, tag]);
  useEffect(() => {
    const options = pendingNavigation.current; pendingNavigation.current = null;
    const key = JSON.stringify([filters, view]);
    const reset = loadedFilterKey.current !== key || !current.current.nodes.length || Boolean(options);
    loadedFilterKey.current = key;
    const include = !options && savedSinceFilterEdit.current.length ? { include: savedSinceFilterEdit.current } : {};
    void load({ reset, limit: reset ? canvasBatchSize : 0, ...include, ...options });
  }, [filters, view, load]);
  const initialRevision = useRef(revision);
  useEffect(() => {
    if (initialRevision.current === revision) return;
    initialRevision.current = revision;
    if (skipExternalReload.current) { skipExternalReload.current = false; return; }
    const include = addedIds !== previousAdded.current ? addedIds : null;
    previousAdded.current = addedIds;
    if (include?.length) savedSinceFilterEdit.current = [...new Set([...savedSinceFilterEdit.current, ...include])];
    void load({ include, ...(isOverview ? { limit: canvasBatchSize } : {}) });
  }, [revision, addedIds, load]);

  async function mutate(path, method, body, after) {
    if (readOnly || writeLock.current || layoutDraft || stale) return;
    writeLock.current = true; setBusy(true); setError("");
    try {
      await request(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!mounted.current) return;
      const options = after?.();
      void load({ ...(isOverview ? { limit: canvasBatchSize } : {}), ...options });
      setDetailRevision((value) => value + 1); skipExternalReload.current = true; onChanged();
    } catch (failure) { if (mounted.current) { setStale(true); setError(`保存失败：${failure.message}`); } }
    finally { writeLock.current = false; if (mounted.current) setBusy(false); }
  }
  async function saveLayout(positions) {
    if (readOnly || view !== "flat" || writeLock.current) return;
    writeLock.current = true; setBusy(true); setLayoutDraft(positions); setError("");
    try {
      await request("/api/canvas/layout", { method: "PUT", body: JSON.stringify({ positions }) });
      if (mounted.current) { setLayoutDraft(null); setMessage("布局已保存"); }
    } catch (failure) { if (mounted.current) setError(`布局未保存：${failure.message}`); }
    finally { writeLock.current = false; if (mounted.current) setBusy(false); }
  }
  function changed(expand) {
    setDetailRevision((value) => value + 1);
    const moved = view === "tags" && filters.tag && expand?.updated && !expand.updated.tags.some((name) => name.toLowerCase() === filters.tag.toLowerCase());
    if (typeof expand === "string" && !isOverview) void load({ expand, limit: canvasBatchSize });
    else void load({ exclude: moved ? expand.updated.id : undefined, limit: isOverview ? canvasBatchSize : 0 });
    if (moved) setMessage("内容已移出当前标签，可返回标签总览查看。");
    skipExternalReload.current = true; onChanged();
  }
  function changeView(next) {
    setSelected(null); setEdgeId(null); setStale(true); setView(next);
    setTag(""); setFilters({ q, tag: "" }); overviewSnapshot.current = null;
  }
  function changeArrangement(next) {
    if (view === "tags" || next === "tags") { changeView(next); return; }
    setSelected(null); setEdgeId(null); setView(next);
  }
  function changeTag(next) {
    if (isOverview && next) overviewSnapshot.current = { nodes, viewport: flow.current?.getViewport(), q: filters.q };
    if (view === "tags" && !next && overviewSnapshot.current?.q === q) pendingNavigation.current = { snapshot: overviewSnapshot.current };
    setSelected(null); setEdgeId(null); setStale(true); setTag(next); setFilters({ q, tag: next });
  }
  function expandElement(id) {
    if (!isOverview) { void load({ expand: id, limit: canvasBatchSize }); return; }
    pendingNavigation.current = { include: [id], expand: id };
    setSelected(null); setEdgeId(null); setStale(true); setView("flat"); setQ(""); setTag(""); setFilters({ q: "", tag: "" });
  }
  const elementNodes = nodes.filter((node) => node.type === "element");
  const selectedEdge = edges.find((entry) => entry.id === edgeId);
  function renameEdge(edge) {
    if (readOnly || !canInteract) return;
    const ids = new Set(edge.data.relationIds || [edge.id]);
    const relations = edges.filter((entry) => ids.has(entry.id)).map((entry) => entry.data);
    if (relations.length) setRenaming(relations);
  }
  return <section className="wiki-canvas" aria-label="关系画布">
    {/* The same floating tool layer as the library: search on top, actions top-right, views and filters in the bottom capsule. */}
    <FloatingLayer className="canvas-float" headerClassName="canvas-heading" filtersClassName="canvas-float-capsule" filtersLabel="画布视图与筛选"
      title={<h1 className="page-title">关系画布</h1>}
      search={<label className="wiki-search"><Search size={17} /><input aria-label="搜索画布内容" placeholder="搜索文字或文件名…" value={q} disabled={blocked} onChange={(event) => setQ(event.target.value)} /></label>}
      actions={!readOnly && <>{headerActions}<Button variant={quietAdd ? "secondary" : "primary"} disabled={blocked} onClick={onAdd}><Plus size={16} />添加内容</Button></>}
      filters={<>
    <div className="canvas-viewbar">
      <div className="canvas-view-switch ui-segmented" role="group" aria-label="画布视图">
        <button aria-pressed={view === "relations"} disabled={blocked || loading} onClick={() => { if (view !== "relations") changeArrangement("relations"); }}><Network size={15} />关系视图</button>
        <button aria-pressed={view === "flat"} disabled={blocked || loading} onClick={() => { if (view !== "flat") changeArrangement("flat"); }}><LayoutGrid size={15} />平铺视图</button>
        <button aria-pressed={view === "tags"} disabled={blocked || loading} onClick={() => { if (view !== "tags") changeView("tags"); }}><Folders size={15} />标签视图</button>
      </div>
      {view === "tags" && <nav className="canvas-breadcrumb" aria-label="标签路径"><button disabled={blocked || loading || isOverview} onClick={() => changeTag("")}>{!isOverview && <ArrowLeft size={14} />}标签总览</button>{!isOverview && <><ChevronRight size={14} /><strong title={filters.tag}>{filters.tag}</strong></>}</nav>}
    </div>
    <div className="canvas-toolbar">
      <Select className="wiki-canvas-tag" aria-label="筛选画布标签" value={tag} disabled={blocked || loading} onChange={changeTag} options={[{ value: "", label: view === "tags" ? "标签总览" : "全部标签" }, ...Array.from(new Set([...(tags.data?.tags || []), ...(tag ? [tag] : [])])).map((name) => ({ value: name, label: name }))]} />
      <button disabled={blocked || loading} onClick={() => load({ reset: true, limit: canvasBatchSize })} title="重新加载筛选结果"><RefreshCw size={15} />刷新</button>
      <button disabled={!nodes.length} onClick={() => flow.current?.fitView({ padding: 0.1, maxZoom: 1, duration: 250 })}><Maximize2 size={15} />适应画面</button>
      <button aria-pressed={showAllEdges} disabled={!edges.length} onClick={() => setShowAllEdges((value) => !value)}><Network size={15} />全部连线</button>
      {!readOnly && view === "flat" && <button disabled={!nodes.length || !canInteract} onClick={() => saveLayout(elementNodes.map(({ id, position }) => ({ id: Number(id), ...position })))}><Save size={15} />保存布局</button>}
    </div>
      </>}>
    {view !== "tags" && <p className="canvas-view-help">看清内容之间的关联：拖动整理位置，点连线可以改关系名称。</p>}
    {view === "relations" && <div className="canvas-relation-guide"><span><i />连接中心</span><span className="canvas-guide-line" /><span>关联内容</span>{graph.groups.length > 0 && <button disabled={!canInteract} onClick={() => { setSelected(null); setEdgeId(null); setExpandedGroups(new Set(graph.groups.every((group) => expandedGroups.has(group.id)) ? [] : graph.groups.map((group) => group.id))); }}>{graph.groups.every((group) => expandedGroups.has(group.id)) ? "收起图片组" : "展开图片组"}</button>}</div>}
    {view === "tags" && <p className="canvas-view-help">{isOverview ? "打开标签查看内容与关联；无标签内容直接展示。多标签内容会出现在各个对应分组。" : readOnly ? "展开关联也可以找到其他标签下的内容。" : "编辑内容和标签会同步到所有视图；展开关联也可以找到其他标签下的内容。"}</p>}
    {tags.error && <p className="wiki-error" role="alert">标签列表读取失败<button onClick={() => setDetailRevision((value) => value + 1)}>重试</button></p>}
    {error && <p className="wiki-error" role="alert">{error}{layoutDraft ? <><button disabled={busy} onClick={() => saveLayout(layoutDraft)}>重试保存</button><button disabled={busy} onClick={() => { setLayoutDraft(null); setNodes([]); void load({ reset: true, limit: canvasBatchSize }); }}>放弃布局更改</button></> : <button disabled={blocked || loading} onClick={() => load({ limit: nodes.length ? 0 : canvasBatchSize })}>刷新画布</button>}</p>}
    {lastDeleted && <div className="canvas-notice">“{elementLabel(lastDeleted)}”已移入回收站<button disabled={!canInteract} onClick={() => mutate(`/api/elements/${lastDeleted.id}/restore`, "POST", null, () => { const include = [lastDeleted.id]; setLastDeleted(null); return { include }; })}>撤销删除</button></div>}
    <div className="canvas-workspace">
      <div className="canvas-stage" ref={stage}>
        <ReactFlow nodes={displayNodes} edges={displayEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} defaultEdgeOptions={defaultEdgeOptions} onNodesChange={onNodesChange}
          onInit={(instance) => { flow.current = instance; }} viewport={viewport || undefined} defaultViewport={viewport || undefined} onViewportChange={setViewport}
          fitView={!viewport} fitViewOptions={{ maxZoom: 1, padding: 0.1 }} minZoom={0.12} maxZoom={1.8}
          nodeExtent={nodeExtent} onlyRenderVisibleElements connectionMode={ConnectionMode.Loose} nodesDraggable={!readOnly && view === "flat" && canInteract}
          nodesConnectable={!readOnly && canInteract} edgesReconnectable={false} deleteKeyCode={null} selectionOnDrag={false} multiSelectionKeyCode={null} zoomOnDoubleClick={false}
          onNodeClick={(_event, node) => { if (node.type === "element") select(node.id); }} onEdgeClick={(_event, edge) => { if (edge.data.bundleGroupId) toggleGroup(edge.data.bundleGroupId); else { setSelected(null); setEdgeId(edge.id); } }} onPaneClick={() => { setSelected(null); setEdgeId(null); }}
          onNodeDoubleClick={(_event, node) => { if (node.type === "element" && canInteract) onOpen(Number(node.id)); }}
          onNodeDragStop={(_event, node) => { void saveLayout([{ id: Number(node.id), x: node.position.x, y: node.position.y }]); }}
          onConnect={({ source, target }) => { if (source !== target) setConnection({ sourceId: Number(source), targetId: Number(target) }); }}
          isValidConnection={({ source, target }) => source !== target} ariaLabelConfig={ariaLabelConfig} proOptions={{ hideAttribution: true }}>
          <Background color="var(--line)" gap={24} size={1} /><Controls showInteractive={false} /><MiniMap pannable zoomable nodeColor={(node) => node.data.hub ? "var(--accent)" : node.type === "cluster" ? "var(--accent-soft)" : "var(--line-strong)"} maskColor="color-mix(in srgb, var(--panel-2) 72%, transparent)" />
        </ReactFlow>
        {!nodes.length && !loading && <div className="canvas-empty"><Network size={34} /><strong>{q || tag ? "没有找到相关内容" : "画布还是空的"}</strong><p>{q || tag ? "试试其他关键词或标签。" : "添加内容后即可查看。"}</p></div>}
        {loading && <div className="canvas-loading" role="status">正在读取画布…</div>}
      </div>
      {(selected || selectedEdge) && <CanvasInspector key={selected || edgeId} id={selected} edge={selectedEdge} nodes={elementNodes} edges={edges} visible={visible}
        revision={`${revision}:${detailRevision}`} busy={blocked || loading || stale} readOnly={readOnly} onClose={() => { setSelected(null); setEdgeId(null); }} onSelect={select}
        onOpen={onOpen} onExpand={expandElement} onChanged={changed} onModalChange={setModal}
        onUnlink={(id) => mutate(`/api/relations/${id}`, "DELETE")}
        onRename={() => renameEdge(selectedEdge)}
        onTrash={(element) => mutate(`/api/elements/${element.id}`, "DELETE", null, () => { setLastDeleted(element); setSelected(null); })} />}
    </div>
    <footer className="canvas-footer"><span>{isOverview && totals ? `${nodes.length - elementNodes.length} / ${totals.groups} 个标签 · ${elementNodes.length} / ${totals.untagged} 条无标签内容` : `${elementNodes.length} 条内容 · ${edges.length} 条关联`}</span><span>单击预览 · 双击打开详情页</span><span className="canvas-help">{readOnly ? "只读浏览 · 拖动背景平移，双指或滚轮缩放" : view === "relations" ? "相同关联的图片自动成组 · 平铺视图可自由摆放" : view === "tags" ? "标签视图自动排布 · 平铺视图可自由摆放" : "拖动卡片顶栏摆放 · 拖动连接点建立关联"}</span>{hasMore && <button disabled={!canInteract || nodes.length >= maxCanvasNodes} onClick={() => load({ limit: canvasBatchSize })}>加载更多</button>}</footer>
    {(nodes.length >= maxCanvasNodes || edgesTruncated) && <p className="canvas-notice">{nodes.length >= maxCanvasNodes ? `当前最多展开 ${maxCanvasNodes} 张卡片。可通过搜索或标签缩小范围。` : ""}{edgesTruncated ? `连线较多，当前显示最近的 ${maxCanvasEdges} 条；其余关联仍然保留。` : ""}</p>}
    {connection && <RelationPicker {...connection} onClose={() => setConnection(null)} onChanged={() => changed()} />}
    {renaming && <RelationRenameDialog relation={renaming[0]} relations={renaming} busy={busy || externalBusy} onBusyChange={setBusy}
      onClose={() => setRenaming(null)} onSaved={() => { setRenaming(null); changed(); setMessage("关联名称已更新"); }} />}
    {message && <p className="canvas-status" role="status">{message}</p>}
    </FloatingLayer>
  </section>;
}
