import { json, text, readJson, readImage, httpError } from './http.js';

export async function handleAgentWorkbenchRoute(service, req, res, url, access, tasks) {
  if (!/^\/api\/agent(?:\/|$)/.test(url.pathname)) return false;
  if (access !== 'local') throw httpError(403, '工作台仅限本机');
  const method = req.method, p = url.pathname.slice('/api/agent'.length), body = () => readJson(req, { maxBytes: 3 * 1024 * 1024 });
  let match, result;
  if (p === '/status' && method === 'GET') result = service.status();
  else if ((match = /^\/engines\/([\w-]+)\/models$/.exec(p)) && method === 'GET') result = await service.models(match[1]);
  else if (p === '/engines/antigravity-acp/connect' && method === 'POST') result = await service.connectAntigravity();
  else if (p === '/storage-inspection' && method === 'GET') result = await tasks.inspectStorage();
  else if (p === '/settings' && method === 'PUT') result = await service.configure(await body());
  else if (p === '/workspaces' && method === 'GET') result = service.projects();
  else if (p === '/workspaces' && method === 'POST') result = await service.workspace(await body());
  else if (p === '/sessions' && method === 'GET') result = { sessions: service.list() };
  else if (p === '/sessions' && method === 'POST') result = service.createSession(await body());
  else if (p === '/wiki-template' && method === 'POST') result = await service.wikiTemplate(await body());
  else if ((match = /^\/legacy\/(\d+)\/continue$/.exec(p)) && method === 'POST') result = await service.continueLegacy(Number(match[1]), await body());
  else if ((match = /^\/sessions\/(\d+)$/.exec(p)) && method === 'PATCH') result = service.configureSession(Number(match[1]), await body());
  else if ((match = /^\/sessions\/(\d+)$/.exec(p)) && method === 'GET') result = service.detail(Number(match[1]));
  else if ((match = /^\/sessions\/(\d+)\/turns$/.exec(p)) && method === 'POST') result = service.submit(Number(match[1]), await body());
  else if ((match = /^\/sessions\/(\d+)\/resume$/.exec(p)) && method === 'POST') result = await service.resume(Number(match[1]));
  else if ((match = /^\/sessions\/(\d+)\/policy$/.exec(p)) && method === 'PUT') result = await service.policy(Number(match[1]), await body());
  else if ((match = /^\/sessions\/(\d+)\/draft$/.exec(p)) && method === 'PUT') result = service.saveDraft(Number(match[1]), await body());
  else if ((match = /^\/sessions\/(\d+)\/attachments$/.exec(p)) && method === 'POST') result = await tasks.upload(Number(match[1]), await readImage(req));
  else if ((match = /^\/sessions\/(\d+)\/proposals\/(\d+)\/decision$/.exec(p)) && method === 'POST') result = service.decideProposal(Number(match[2]), Number(match[1]), await body());
  else if ((match = /^\/sessions\/(\d+)\/image-operations$/.exec(p)) && method === 'POST') { const value = await body(); result = tasks.submit(Number(match[1]), Number(value.turnId), value); }
  else if ((match = /^\/operations\/([a-f0-9-]{36})(\/decision)?$/.exec(p))) {
    const sessionId = Number(url.searchParams.get('sessionId'));
    if (method === 'GET' && !match[2]) result = tasks.operation(match[1], sessionId);
    else if (method === 'POST' && match[2]) result = tasks.decide(match[1], sessionId, await body());
    else throw httpError(405, 'Method not allowed');
  }
  else if ((match = /^\/tasks\/(\d+)(\/cancel)?$/.exec(p))) {
    const sessionId = Number(url.searchParams.get('sessionId'));
    if (method === 'GET' && !match[2]) result = tasks.get(Number(match[1]), sessionId);
    else if (method === 'POST' && match[2]) result = tasks.cancel(Number(match[1]), sessionId, await body());
    else throw httpError(405, 'Method not allowed');
  }
  else if ((match = /^\/tasks\/(\d+)\/(reconcile|reexecute)$/.exec(p)) && method === 'POST') {
    const sessionId = Number(url.searchParams.get('sessionId')); result = await tasks[match[2]](Number(match[1]), sessionId, await body());
  }
  else if ((match = /^\/artifacts\/(\d+)(\/content)?$/.exec(p)) && method === 'GET') {
    const sessionId = Number(url.searchParams.get('sessionId'));
    if (!match[2]) result = tasks.artifact(Number(match[1]), sessionId);
    else { const value = await tasks.content(Number(match[1]), sessionId); res.setHeader('x-content-type-options', 'nosniff'); text(res, 200, value.bytes, value.artifact.mimeType); return true; }
  }
  else if ((match = /^\/artifacts\/(\d+)\/wiki$/.exec(p)) && method === 'POST') result = await tasks.saveToWiki(Number(match[1]), Number(url.searchParams.get('sessionId')));
  else if ((match = /^\/turns\/(\d+)\/cancel$/.exec(p)) && method === 'POST') result = await service.cancel(Number(match[1]));
  else if ((match = /^\/turns\/(\d+)\/changes$/.exec(p)) && method === 'GET') result = await service.changes(Number(match[1]));
  else if ((match = /^\/turns\/(\d+)\/changes\/undo$/.exec(p)) && method === 'POST') result = await service.undoChanges(Number(match[1]), await body());
  else if ((match = /^\/turns\/(\d+)\/commands\/([a-f0-9-]{36})\/output$/.exec(p)) && method === 'GET') result = await service.commandOutput(Number(match[1]), match[2], Number(url.searchParams.get('offset') || 0));
  else if ((match = /^\/approvals\/(\d+)\/decision$/.exec(p)) && method === 'POST') result = service.decide(Number(match[1]), await body());
  else if ((match = /^\/sessions\/(\d+)\/events$/.exec(p)) && method === 'GET') {
    const id = Number(match[1]); let after = Math.max(Number(url.searchParams.get('after') || 0), Number(req.headers['last-event-id'] || 0));
    if (!Number.isSafeInteger(after) || after < 0) throw httpError(400, '无效事件游标');
    service.detail(id);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const publish = () => {
      if (res.destroyed) return;
      const events = service.events(id, after);
      for (const event of events) { after = event.seq; res.write(`id: ${after}\ndata: ${JSON.stringify(event)}\n\n`); }
      if (!events.length) res.write(': keepalive\n\n');
      // A slow client resumes by cursor instead of accumulating an unbounded queue.
      if (res.writableLength > 2 * 1024 * 1024) res.end();
    };
    publish(); const timer = setInterval(publish, 300);
    res.once('close', () => clearInterval(timer)); return true;
  } else throw httpError(404, '工作台接口不存在');
  json(res, 200, result); return true;
}
