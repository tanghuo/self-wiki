import { json, readJson, httpError } from './http.js';

export async function handleLocalAuthRoute(auth, req, res, url) {
  if (!url.pathname.startsWith('/api/auth/')) return false;
  res.setHeader('cache-control', 'no-store');
  if (url.pathname === '/api/auth/bootstrap' && req.method === 'POST') {
    const { code } = await readJson(req, { maxBytes: 1024 });
    res.setHeader('set-cookie', auth.redeem(code));
    json(res, 200, { ok: true }); return true;
  }
  if (!auth.isManagement(req)) throw httpError(401, '需要本机配对；请使用本机启动器打开，或输入一次性配对码');
  if (url.pathname === '/api/auth/session' && req.method === 'GET') json(res, 200, { ok: true });
  else if (url.pathname === '/api/auth/code' && req.method === 'POST') json(res, 200, { code: auth.createBootstrapCode() });
  else throw httpError(404, 'Unknown authentication route');
  return true;
}
