import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mergeEdits } from "../../src/renderer/src/settingsMerge.js";

const root = path.resolve(import.meta.dirname, "../..");
const renderer = path.join(root, "src/renderer/src");

async function loadUi() {
  // Bundle next to node_modules so the bare react / lucide-react imports resolve.
  const cache = path.join(root, "node_modules", ".cache");
  await mkdir(cache, { recursive: true });
  const dir = await mkdtemp(path.join(cache, "self-wiki-ui-"));
  const outfile = path.join(dir, "ui.mjs");
  await build({ entryPoints: [path.join(renderer, "ui/index.js")], bundle: true, format: "esm", platform: "node", jsx: "automatic", outfile, logLevel: "silent",
    external: ["react", "react-dom", "react/jsx-runtime", "lucide-react"], nodePaths: [path.join(root, "node_modules")] });
  try { return await import(pathToFileURL(outfile)); } finally { await rm(dir, { recursive: true, force: true }); }
}
const ui = await loadUi();
const Icon = () => h("svg");

test("buttonClass maps the four levels and three sizes onto the shared classes", () => {
  assert.equal(ui.buttonClass(), "");
  assert.equal(ui.buttonClass({ variant: "primary" }), "primary");
  assert.equal(ui.buttonClass({ variant: "ghost", size: "sm" }), "text-button button-sm");
  assert.equal(ui.buttonClass({ variant: "danger" }), "danger-quiet");
  assert.equal(ui.buttonClass({ variant: "danger-solid", size: "lg" }), "danger button-lg");
  assert.throws(() => ui.buttonClass({ variant: "workflow-primary" }), /Unknown button variant/);
  assert.throws(() => ui.buttonClass({ size: "xl" }), /Unknown button size/);
});

test("a disabled button explains why it cannot be used", () => {
  const html = renderToStaticMarkup(h(ui.Button, { variant: "primary", disabled: true, disabledReason: "先选择内容" }, "保存"));
  assert.match(html, /<button[^>]*class="primary"[^>]*disabled=""[^>]*aria-describedby="([^"]+)"/);
  const id = html.match(/aria-describedby="([^"]+)"/)[1];
  assert.match(html, new RegExp(`<span id="${id}" class="ui-disabled-reason">先选择内容</span>`));
  assert.doesNotMatch(renderToStaticMarkup(h(ui.Button, { disabledReason: "先选择内容" }, "保存")), /ui-disabled-reason/);
});

test("icon-only buttons require an accessible name", () => {
  assert.throws(() => renderToStaticMarkup(h(ui.IconButton, { icon: Icon })), /needs a label/);
  assert.match(renderToStaticMarkup(h(ui.IconButton, { icon: Icon, label: "关闭", shortcut: "Esc" })), /aria-label="关闭"[^>]*title="关闭 · Esc"/);
});

test("every page header has the same structure: back link, one title, actions on the right", () => {
  const html = renderToStaticMarkup(h(ui.PageHeader, { title: "工作流", subtitle: "说明", back: { label: "工作流列表", onClick() {} }, actions: h("button", { className: "primary" }, "运行") }));
  assert.match(html, /^<header class="page-header"><button[^>]*class="text-button button-sm page-back"[^>]*aria-label="返回工作流列表"/);
  assert.equal(html.match(/<h1/g).length, 1);
  assert.match(html, /<p class="page-header-sub">说明<\/p>/);
  assert.match(html, /<div class="page-header-actions"><button class="primary">运行<\/button><\/div>/);
});

test("tabs are tabs and segmented controls are pressed toggles, not button styles", () => {
  const tabs = renderToStaticMarkup(h(ui.Tabs, { label: "页面", value: "b", items: [{ value: "a", label: "运行" }, { value: "b", label: "记录", count: 3 }] }));
  assert.match(tabs, /class="ui-tabs" role="tablist" aria-label="页面"/);
  assert.match(tabs, /role="tab" aria-selected="false">运行/);
  assert.match(tabs, /role="tab" aria-selected="true">记录<span class="ui-tab-count">3<\/span>/);
  const seg = renderToStaticMarkup(h(ui.Segmented, { label: "视图", value: "grid", onChange() {}, items: [{ value: "grid", label: "网格" }, { value: "masonry", label: "瀑布流" }] }));
  assert.match(seg, /class="ui-segmented" role="group" aria-label="视图"/);
  assert.match(seg, /aria-pressed="true"><span>网格/);
});

test("the settings save bar counts unsaved sections and offers one save", () => {
  const dirty = renderToStaticMarkup(h(ui.SaveBar, { dirtyCount: 2, dirtyLabels: ["局域网共享", "Agent 连接"] }, h("button", null, "关闭")));
  assert.match(dirty, /role="region" aria-label="保存设置"/);
  assert.match(dirty, /2 项改动未保存：局域网共享、Agent 连接/);
  assert.match(dirty, /放弃改动<\/button><button>关闭<\/button><button type="button" class="primary">保存<\/button>/);
  const clean = renderToStaticMarkup(h(ui.SaveBar, { dirtyCount: 0 }));
  assert.match(clean, /所有改动已保存/);
  assert.match(clean, /class="primary" disabled="" title="没有需要保存的改动"/);
  assert.doesNotMatch(clean, /放弃改动/);
});

test("empty states have one icon, one heading and optional actions", () => {
  const html = renderToStaticMarkup(h(ui.EmptyState, { icon: Icon, title: "回收站是空的", actions: h("button", null, "清空筛选") }, "移入回收站的内容会保留在这里。"));
  assert.match(html, /^<div class="ui-empty"><span class="ui-empty-icon" aria-hidden="true"><svg><\/svg><\/span><h2>回收站是空的<\/h2><p>移入回收站的内容会保留在这里。<\/p><div class="ui-empty-actions"><button>清空筛选<\/button><\/div><\/div>$/);
});

test("design tokens: three control heights, a 4px spacing grid and a brighter dark-mode danger colour", async () => {
  const themes = await readFile(path.join(renderer, "themes.css"), "utf8");
  assert.match(themes, /--h-sm: 28px; --h-md: 36px; --h-lg: 44px;/);
  for (const [, value] of themes.matchAll(/--sp-\d+: (\d+)px/g)) assert.equal(Number(value) % 4, 0, `spacing ${value}px is on the 4px grid`);
  const night = themes.slice(themes.indexOf('[data-theme="night"]'));
  assert.match(night.slice(0, night.indexOf("}")), /--bad-solid: #d93f45/);
});

test("two settings panels editing one config keep each other's saved changes", () => {
  const saved = { applyMode: "auto", chat: { engine: "codex", model: null }, executor: { codexCli: { executable: "codex" } } };
  const latest = { ...saved, chat: { engine: "grok-build", model: null } }; // saved meanwhile by the other panel
  const edited = { ...saved, applyMode: "suggest" };
  assert.deepEqual(mergeEdits(latest, saved, edited), { ...latest, applyMode: "suggest" });
  assert.deepEqual(mergeEdits(latest, saved, saved), latest);
});
