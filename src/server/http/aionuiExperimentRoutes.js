import { httpError, json } from './http.js';

export async function handleAionuiExperimentRoute(service, req, res, url, access) {
  if (!/^\/api\/aionui(?:\/|$)/.test(url.pathname)) return false;
  if (access !== 'local') throw httpError(403, 'AionUi 实验版仅限本机');
  if (url.pathname === '/api/aionui/status' && req.method === 'GET') json(res, 200, await service.status());
  else if (url.pathname === '/api/aionui/start' && req.method === 'POST') {
    const result = await service.launch();
    res.setHeader('set-cookie', result.cookies);
    json(res, 200, result.status);
  } else if (url.pathname === '/api/aionui/stop' && req.method === 'POST') {
    await service.stop(); json(res, 200, await service.status());
  } else throw httpError(404, '实验版接口不存在');
  return true;
}
