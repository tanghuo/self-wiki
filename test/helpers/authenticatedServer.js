// Existing behavior tests run as a paired local user. Security tests deliberately
// import the real server and global fetch to exercise anonymous requests.
import { createServer as startServer } from '../../src/server/server.js';
import { chromium as browserType } from 'playwright-core';
const servers = new Map();
const rawFetch = globalThis.fetch;

export async function createServer(options) {
  const app = await startServer(options), origin = new URL(app.url).origin;
  servers.set(origin, app);
  const close = app.close;
  app.close = async () => { servers.delete(origin); await close(); };
  return app;
}

export function tokenFileForUrl(url) { return servers.get(new URL(url).origin)?.credentialFile; }
export function fetch(input, init = {}) {
  const url = new URL(input instanceof Request ? input.url : input);
  const app = servers.get(url.origin);
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  if (app && !headers.has('authorization')) headers.set('authorization', app.managementHeaders().authorization);
  return rawFetch(input, { ...init, headers });
}

function wrapPage(page) {
  if (page.authenticatedTestPage) return page;
  page.authenticatedTestPage = true;
  const goto = page.goto.bind(page);
  page.goto = async (url, options) => {
    const app = servers.get(new URL(url).origin);
    if (app) {
      const response = await rawFetch(new URL('/api/auth/bootstrap', app.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: app.createBootstrapCode() }) });
      if (!response.ok) throw new Error('Test browser pairing failed');
      const pair = response.headers.get('set-cookie').split(';')[0], at = pair.indexOf('=');
      await page.context().addCookies([{ name: pair.slice(0, at), value: pair.slice(at + 1), url: app.url, httpOnly: true, sameSite: 'Strict' }]);
    }
    const response = await goto(url, options);
    if (app && new URL(url).pathname === '/') await page.locator('.app-layout').waitFor();
    return response;
  };
  return page;
}
function wrapContext(context) {
  for (const page of context.pages()) wrapPage(page);
  const newPage = context.newPage.bind(context);
  context.newPage = async (...args) => wrapPage(await newPage(...args));
  return context;
}
export const chromium = {
  ...browserType,
  async launch(...args) {
    const browser = await browserType.launch(...args);
    const newPage = browser.newPage.bind(browser), newContext = browser.newContext.bind(browser);
    browser.newPage = async (...params) => wrapPage(await newPage(...params));
    browser.newContext = async (...params) => wrapContext(await newContext(...params));
    return browser;
  },
  async launchPersistentContext(...args) { return wrapContext(await browserType.launchPersistentContext(...args)); },
};
