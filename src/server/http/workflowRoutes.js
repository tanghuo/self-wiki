import { json, text, readJson, readImage, httpError } from './http.js';

export async function handleWorkflowRoute(workflow, req, res, url, access) {
  if (!/^\/api\/(?:workflows|workflow-node-types|workflow-runs|workflow-artifacts|workflow-input-images)(?:\/|$)/.test(url.pathname)) return false;
  if (access !== 'local') throw httpError(403, '工作流定义、运行、事件与产物仅限本机');
  const method = req.method, p = url.pathname;
  const body = () => readJson(req, { maxBytes: 1024 * 1024 });
  let match, result;
  if (p === '/api/workflow-input-images' && method === 'POST') {
    let originalName;
    try { originalName = decodeURIComponent(req.headers['x-file-name'] || '粘贴图片.png'); }
    catch { throw httpError(400, '无效的文件名'); }
    result = await workflow.addInputImage(await readImage(req), originalName);
  }
  else if ((match = /^\/api\/workflow-input-images\/([a-f0-9-]+)\/media$/.exec(p)) && method === 'GET') {
    result = await workflow.inputImage(match[1]);
    res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
    text(res, 200, result.bytes, result.contentType); return true;
  }
  else if (p === '/api/workflow-node-types' && method === 'GET') result = workflow.catalog();
  else if ((match = /^\/api\/workflows\/adapters\/([a-z0-9_-]+)\/([a-z0-9_-]+)$/.exec(p)) && ['GET', 'POST'].includes(method)) result = await workflow.adapterConfiguration(match[1], match[2], method === 'POST' ? await body() : undefined, method);
  else if ((match = workflow.adapterConfigurationRoute(p))) result = await workflow.adapterConfiguration(match.adapter, match.operation, method === 'POST' ? await body() : undefined, method);
  else if (p === '/api/workflows' && method === 'GET') result = { workflows: workflow.list() };
  else if (p === '/api/workflows' && method === 'POST') result = workflow.create(await body());
  else if ((match = /^\/api\/workflows\/(\d+)$/.exec(p)) && method === 'GET') result = workflow.get(match[1]);
  else if (match && method === 'PUT') result = workflow.save(match[1], await body());
  else if ((match = /^\/api\/workflows\/(\d+)\/validate$/.exec(p)) && method === 'POST') result = workflow.validate(match[1], await body());
  else if ((match = /^\/api\/workflows\/(\d+)\/runs$/.exec(p)) && method === 'POST') result = await workflow.createRun(match[1], await body());
  else if ((match = /^\/api\/workflow-runs\/(\d+)$/.exec(p)) && method === 'GET') result = workflow.run(match[1], { after: Number(url.searchParams.get('after') || 0), limit: Number(url.searchParams.get('limit') || 100) });
  else if ((match = /^\/api\/workflow-runs\/(\d+)\/events$/.exec(p)) && method === 'GET') result = workflow.events(match[1], Number(url.searchParams.get('after') || 0));
  else if ((match = /^\/api\/workflow-runs\/(\d+)\/batches\/(\d+)$/.exec(p)) && method === 'GET') result = workflow.batch(match[1], match[2], Number(url.searchParams.get('offset') || 0));
  else if ((match = /^\/api\/workflow-runs\/(\d+)\/actions$/.exec(p)) && method === 'POST') result = workflow.control(match[1], await body());
  else if ((match = /^\/api\/workflow-runs\/(\d+)\/nodes\/(\d+)\/actions$/.exec(p)) && method === 'POST') result = await workflow.nodeAction(match[1], match[2], await body());
  else if ((match = /^\/api\/workflow-runs\/(\d+)\/reviews$/.exec(p)) && method === 'POST') result = workflow.batchReview(match[1], await body());
  else if ((match = /^\/api\/workflow-runs\/(\d+)\/derive$/.exec(p)) && method === 'POST') result = await workflow.derive(match[1], await body());
  else if ((match = /^\/api\/workflow-runs\/(\d+)\/edit-version$/.exec(p)) && method === 'POST') result = workflow.editVersion(match[1], await body());
  else if ((match = /^\/api\/workflow-artifacts\/([a-f0-9-]+)(\/media)?$/.exec(p)) && method === 'GET') {
    result = await workflow.artifact(match[1], Number(url.searchParams.get('runId')), !!match[2]);
    if (match[2]) { res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff'); text(res, 200, result.bytes, result.contentType); return true; }
  } else throw httpError(404, '工作流接口不存在');
  json(res, 200, result); return true;
}
