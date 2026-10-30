// UI fixtures must not start real account CLIs when the workbench preloads.
export async function stubWorkbenchModels(page) {
  await page.route('**/api/agent/engines/*/models', route => {
    const grok = route.request().url().includes('/grok-build/');
    const id = grok ? 'grok-4.6' : 'fixture-model';
    return route.fulfill({ json: { models: [{ id, label: id }], defaultModel: id } });
  });
}
