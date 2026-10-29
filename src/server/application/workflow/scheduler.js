import { dependencies, outputType, outputBindingType, matchesType, summarizeRun, workflowLimits, loopItems } from '../../../shared/domain/workflow/contracts.js';
import { externalKeyLimit, externalResourceLimits } from '../../../shared/domain/externalResources.js';

export function createWorkflowScheduler({ repo, nodes, store, interval = 1000 }) {
  const active = new Map();
  let timer, closed = false, ticking = false, started = false;
  const graphFor = (run, i) => i.scope === 'root' ? run.definition : run.definition.nodes.find((n) => n.id === i.context.foreachId)?.config.body;
  const resourceFor = (run, i, n) => {
    const snapshot = run.executors[`${i.scope === 'root' ? 'root' : `root/${i.context.foreachId}`}/${n.id}`];
    return nodes.resource(snapshot);
  };
  function settle(runId) {
    const r = repo.run(runId), all = repo.instances(runId);
    // Failed dependencies are blocked by tick. Waiting descendants alone should
    // not make a review/unknown run look as though it is actively executing.
    const relevant = all.filter((i) => i.state !== 'pending');
    let state = summarizeRun(all.map((i) => ({ ...i, serviceFault: i.data.serviceFault })), r);
    if (!r.cancelled && !r.paused && !all.some((i) => i.state === 'unknown' || i.data.serviceFault) && !activeFor(runId) && all.some((i) => i.state === 'waiting_review')) state = 'waiting_review';
    if (state === 'succeeded' && all.some((i) => i.data.partialFailed)) state = 'partial_failed';
    if (!relevant.length && !all.length) state = 'succeeded';
    if (state !== r.state) { repo.setRunState(runId, state); repo.event(runId, 'run.state', null, null, { state }); }
  }
  const activeFor = (runId) => [...active.values()].some((a) => a.runId === runId);
  async function execute(n, i, run) {
    const controller = new AbortController();
    const entry = { controller, runId: run.id, resource: resourceFor(run, i, n) };
    active.set(i.id, entry);
    entry.promise = (async () => {
      try {
        const siblings = repo.instances(run.id, { scope: i.scope });
        const result = await nodes.execute({ n, i, run, siblings, signal: controller.signal });
        if (result.foreach) return; // The persistent parent is driven incrementally by tick.
        if (result.review) { repo.waiting(i.id, i.attemptId, { type: outputType(n), value: result.value }); return; }
        if (result.failed) { repo.complete(i.id, i.attemptId, 'failed', result.artifacts, result.error); return; }
        let value = result.value;
        const artifacts = [...(result.extra || [])];
        if (result.images) {
          for (const image of result.images) artifacts.push({ ...image, port: `image:${image.id}` });
          value = result.images.map((a) => ({ artifactId: a.id }));
        }
        if (!matchesType(value, outputType(n))) throw new Error('节点输出与声明类型不匹配');
        const encoded = JSON.stringify(value);
        if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw new Error('节点输出超过 2 MiB');
        artifacts.push({ type: outputType(n), value, metadata: { nodeType: n.type, inputs: n.inputs, adapterId: n.config.adapterId || n.config.executor || null } });
        repo.complete(i.id, i.attemptId, 'succeeded', artifacts);
      } catch (error) {
        const state = error.unknown ? 'unknown' : controller.signal.aborted ? 'cancelled' : 'failed';
        repo.complete(i.id, i.attemptId, state, [], String(error.message).slice(0, 1500), { serviceFault: !!error.serviceFault });
      } finally {
        active.delete(i.id);
        if (!closed && repo.owns()) { settle(run.id); wake(); }
      }
    })();
  }
  function advanceLoop(run, n, parent, all) {
    const siblings = all.filter((i) => i.scope === parent.scope), values = nodes.inputs(n, siblings, parent.context);
    values.items = loopItems(n, values.items);
    if (values.items.length > (n.config.maxItems || workflowLimits.items)) throw new Error('循环项数超过 maxItems，不会截断输入');
    const body = n.config.body, children = all.filter((i) => i.context.parentInstanceId === parent.id);
    const grouped = new Map();
    for (const child of children) { const list = grouped.get(child.context.index) || []; list.push(child); grouped.set(child.context.index, list); }
    let unfinished = [...grouped.values()].filter((group) => group.some((i) => ['pending', 'running', 'waiting_review', 'unknown'].includes(i.state))).length;
    let expanded = grouped.size;
    if (!body.nodes.length) expanded = values.items.length;
    if (!run.paused && !run.cancelled) {
      const captures = Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'items'));
      while (expanded < values.items.length && unfinished < externalResourceLimits.loopInFlight) {
        repo.expand(parent, body, expanded, values.items[expanded], captures);
        wake();
        unfinished++; expanded++;
      }
    }
    if (expanded < values.items.length || unfinished) return;
    const rows = values.items.map((_item, index) => {
      const group = grouped.get(index) || [], outputs = {};
      const state = group.every((i) => i.state === 'succeeded') ? 'succeeded' : group.some((i) => i.state === 'failed') ? 'failed' : group.some((i) => i.state === 'cancelled') ? 'cancelled' : 'failed';
      for (const [port, binding] of Object.entries(body.outputs || {})) {
        const source = group.find((i) => i.nodeId === binding.nodeId);
        if (source?.state === 'succeeded') outputs[port] = { artifactRef: nodes.outputArtifact(source.outputs, binding.port), type: outputBindingType(body.nodes.find((n) => n.id === binding.nodeId), binding), path: binding.path || [] };
      }
      return { itemId: `${run.id}:${n.id}:${index}`, index, status: state, outputs, error: group.find((i) => i.error)?.error || null };
    });
    const failed = rows.filter((r) => r.status !== 'succeeded').length;
    repo.complete(parent.id, parent.attemptId, failed && failed === rows.length ? 'failed' : 'succeeded', [{ type: 'list<json>', value: rows }], failed ? `${failed} 个循环项未成功` : '', { partialFailed: failed > 0 });
  }
  function tick() {
    if (!started || closed || ticking || !repo.owns()) return;
    ticking = true;
    try {
      const runs = repo.pendingRuns(), faults = new Set();
      for (const r of runs) for (const i of repo.instances(r.id)) if (i.data.serviceFault) {
        const n = graphFor(r, i)?.nodes.find((n) => n.id === i.nodeId); if (n) faults.add(resourceFor(r, i, n));
      }
      for (const r of runs) {
        if (r.cancelled) continue;
        const all = repo.instances(r.id);
        // Recompute loop parents even while paused, but expand no new items.
        for (const parent of all.filter((i) => i.scope === 'root' && i.state === 'running')) {
          const n = r.definition.nodes.find((n) => n.id === parent.nodeId);
          if (n?.type !== 'foreach') continue;
          try { advanceLoop(r, n, parent, all); } catch (e) { repo.complete(parent.id, parent.attemptId, 'failed', [], e.message); }
        }
        if (!r.paused) for (const i of all.filter((i) => i.state === 'pending')) {
          if (active.size >= 16) break;
          const graph = graphFor(r, i), n = graph?.nodes.find((n) => n.id === i.nodeId);
          if (!n) { repo.setInstance(i.id, 'failed', '节点定义缺失'); continue; }
          if (faults.has(resourceFor(r, i, n))) continue;
          const resource = resourceFor(r, i, n);
          const externals = [...active.values()].filter((entry) => entry.resource);
          if (resource && (externals.filter((entry) => entry.resource === resource).length >= externalKeyLimit(resource) || externals.length >= externalResourceLimits.total)) continue;
          const upstream = dependencies(n).map((id) => all.find((s) => s.scope === i.scope && s.nodeId === id));
          const aggregate = (s) => s && ['succeeded', 'failed'].includes(s.state) && s.outputs.value && graph.nodes.find((node) => node.id === s.nodeId)?.type === 'foreach' && (n.config.acceptPartial || n.config.operation === 'successes');
          const bad = upstream.some((s) => !s || !aggregate(s) && (['failed', 'blocked', 'cancelled', 'unknown'].includes(s.state) || s.data.partialFailed && !n.config.acceptPartial && n.config.operation !== 'successes'));
          if (bad) { repo.setInstance(i.id, 'blocked', '上游失败、拒绝、未知或部分失败'); continue; }
          if (!upstream.every((s) => s.state === 'succeeded' || aggregate(s))) continue;
          const claimed = repo.claim(i.id);
          if (claimed) void execute(n, claimed, r);
        }
        settle(r.id);
      }
    } finally { ticking = false; }
  }
  function wake() { if (started && !closed) { clearTimeout(timer); timer = setTimeout(tick, 0); timer.unref?.(); } }
  let heartbeat;
  return {
    start() { if (started || closed) return; repo.initializeOwner(); repo.recover(); started = true; heartbeat = setInterval(tick, interval); heartbeat.unref?.(); wake(); },
    wake,
    cancel(runId) { for (const entry of active.values()) if (entry.runId === runId) entry.controller.abort(); },
    async close() { closed = true; clearTimeout(timer); clearInterval(heartbeat); for (const entry of active.values()) entry.controller.abort(); await Promise.allSettled([...active.values()].map((e) => e.promise)); },
    settle,
  };
}
