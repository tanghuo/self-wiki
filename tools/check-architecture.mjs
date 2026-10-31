import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(projectRoot, "src");

const rules = [
  {
    from: 'src/server/application/agentWorkbench/',
    disallow: ['src/agent/', 'src/server/http/', 'src/renderer/'],
    message: 'Workbench orchestration must use executorsPort and shared contracts',
  },
  {
    from: 'src/server/application/agentTasks/',
    disallow: ['src/agent/', 'src/server/http/', 'src/renderer/'],
    message: 'Independent tasks must use executorsPort and workflow service contracts',
  },
  {
    from: "src/server/application/workflow/",
    disallow: ["src/server/application/executorsPort.js", "src/server/application/modelAdapters/grok.js", "src/server/application/modelAdapters/comfyui.js", "src/shared/domain/comfyui.js", "src/shared/domain/imageGeneration.js"],
    message: "Workflow must use the adapter registry rather than provider implementations",
  },
  {
    from: "src/renderer/src/features/workflow/",
    disallow: ["src/renderer/src/features/modelAdapters/ComfyuiConfiguration.jsx", "src/shared/domain/comfyui.js", "src/shared/domain/imageGeneration.js"],
    message: "Workflow UI must use adapter fields rather than provider-specific configuration",
  },
  {
    from: "src/agent/",
    disallow: ["src/server/", "src/renderer/", "src/main/", "src/cli/"],
    message: "Agent worker must use HTTP and shared contracts rather than application internals",
  },
  {
    from: "src/cli/",
    disallow: ["src/server/", "src/renderer/", "src/main/"],
    message: "CLI must use HTTP rather than importing server or desktop internals",
  },
  {
    from: "src/shared/",
    disallow: ["src/server/", "src/renderer/", "src/main/"],
    message: "shared domain must not depend on server, renderer, or main",
  },
  {
    from: "src/server/data/",
    disallow: [
      "src/server/http/",
      "src/server/application/",
      "src/server/assets/",
      "src/renderer/",
    ],
    message: "data layer must not depend on HTTP, application, assets, or renderer",
  },
  {
    from: "src/server/application/",
    disallow: ["src/server/http/", "src/renderer/", "src/agent/"],
    allowFiles: ["src/server/application/executorsPort.js"],
    message: "application layer must not depend on HTTP, renderer, or agent (use executorsPort)",
  },
  {
    from: "src/server/features/",
    disallow: ["src/renderer/", "src/agent/"],
    message: "feature modules must not import renderer or agent (use application ports)",
  },
  {
    from: "src/server/http/",
    disallow: ["src/server/data/", "src/renderer/"],
    message: "HTTP layer must not import data modules directly or renderer code",
  },
  {
    from: "src/renderer/",
    disallow: ["src/server/"],
    message: "renderer must not import server modules",
  },
];

const importPattern =
  /(?:import\s+(?:[^'"]+\s+from\s+)?|export\s+(?:[^'"]+\s+from\s+)|import\s*\()\s*["']([^"']+)["']/g;

function toRepoPath(filePath) {
  return path.relative(projectRoot, filePath).replaceAll(path.sep, "/");
}

function normalizeRelativeImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return "";
  const absolute = path.resolve(path.dirname(fromFile), specifier);
  return toRepoPath(absolute);
}

async function collectJavaScriptFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJavaScriptFiles(fullPath));
      continue;
    }
    if (entry.isFile() && /\.(?:js|jsx|mjs|cjs)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

async function pathExists(value) {
  try {
    await stat(value);
    return true;
  } catch {
    return false;
  }
}

function matchesBoundary(importPath, boundary) {
  return importPath === boundary.slice(0, -1) || importPath.startsWith(boundary);
}

function checkFileImports(filePath, source) {
  const repoPath = toRepoPath(filePath);
  const violations = [];
  const fileRules = rules.filter((rule) => repoPath.startsWith(rule.from));
  if (!fileRules.length) return violations;

  for (const match of source.matchAll(importPattern)) {
    const importPath = normalizeRelativeImport(filePath, match[1]);
    if (!importPath) continue;

    for (const rule of fileRules) {
      if (rule.allowFiles?.includes(repoPath)) continue;
      const disallowed = rule.disallow.find((boundary) => matchesBoundary(importPath, boundary));
      if (disallowed) {
        violations.push({
          file: repoPath,
          specifier: match[1],
          importPath,
          message: rule.message,
        });
      }
    }
  }

  return violations;
}

if (!await pathExists(sourceRoot)) {
  throw new Error(`Missing source directory: ${sourceRoot}`);
}

const files = await collectJavaScriptFiles(sourceRoot);
const violations = [];
const imports = new Map();

for (const file of files) {
  const source = await readFile(file, "utf8");
  imports.set(file, [...source.matchAll(importPattern)].map((match) => match[1])
    .filter((specifier) => specifier.startsWith(".")).map((specifier) => path.resolve(path.dirname(file), specifier)));
  violations.push(...checkFileImports(file, source));
  for (const match of source.matchAll(importPattern)) {
    if (match[1].startsWith(".") && !await pathExists(path.resolve(path.dirname(file), match[1]))) {
      throw new Error(`${toRepoPath(file)} imports missing file: ${match[1]}`);
    }
    if (toRepoPath(file).startsWith("src/shared/") && match[1].startsWith("node:")) {
      throw new Error(`Shared domain imports Node infrastructure: ${toRepoPath(file)}`);
    }
  }
  if (!file.endsWith(".jsx")) execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

const checked = new Set(), visiting = new Set(), chain = [];
function checkCycles(file) {
  if (visiting.has(file)) throw new Error(`Circular source imports: ${[...chain.slice(chain.indexOf(file)), file].map(toRepoPath).join(" -> ")}`);
  if (checked.has(file)) return;
  visiting.add(file); chain.push(file);
  for (const dependency of imports.get(file) || []) checkCycles(dependency);
  chain.pop(); visiting.delete(file); checked.add(file);
}
for (const file of files) checkCycles(file);

try {
  const ignored = execFileSync("git", ["check-ignore", "--stdin"], {
    cwd: projectRoot, input: files.map(toRepoPath).join("\n") + "\n", encoding: "utf8",
  });
  if (ignored.trim()) throw new Error(`Source files are ignored by Git:\n${ignored}`);
} catch (error) {
  if (error.status !== 1) throw error;
}

// Design-system rules (docs/design-system.md): colours live only in themes.css as tokens, there is one
// primary button class, and control heights come from the 28 / 36 / 44 tokens.
const rendererRoot = path.join(sourceRoot, "renderer", "src");
async function collectStyleFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await collectStyleFiles(full));
    else if (entry.name.endsWith(".css")) found.push(full);
  }
  return found;
}
const designViolations = [];
for (const file of await collectStyleFiles(rendererRoot)) {
  if (path.basename(file) === "themes.css") continue;
  const css = (await readFile(file, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of css.matchAll(/(?<![\w-])(#[0-9a-fA-F]{3,8}\b|rgba?\((?!var\()|hsla?\()/g)) designViolations.push(`${toRepoPath(file)} uses a raw colour "${match[0]}"; use a token from themes.css`);
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/\b(button|summary)\b|\.button\b/.test(rule[1])) continue;
    for (const height of rule[2].matchAll(/(?:^|;|\s)(?:min-)?height\s*:\s*(\d+)px/g)) {
      const value = Number(height[1]);
      if (value >= 22 && value <= 48) designViolations.push(`${toRepoPath(file)} sets a ${value}px control height on "${rule[1].trim().slice(0, 60)}"; use var(--h-sm|md|lg)`);
    }
  }
}
for (const file of await collectStyleFiles(rendererRoot)) {
  const css = (await readFile(file, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of css.matchAll(/font-weight\s*:\s*(\d+|bold|bolder)/g)) {
    if (!/^\d+$/.test(match[1]) || Number(match[1]) > 600) designViolations.push(`${toRepoPath(file)} sets font-weight ${match[1]}; the scale is 400 / 500 / 600`);
  }
}

// Scan JSX opening tags with brace/quote awareness ("=>" inside attributes must not end the tag).
function jsxOpeningTags(source, name) {
  const tags = [];
  for (const start of source.matchAll(new RegExp(`<${name}\\b`, "g"))) {
    let depth = 0, quote = "", index = start.index + 1;
    for (; index < source.length; index++) {
      const char = source[index];
      if (quote) { if (char === quote) quote = ""; else if (char === "\\") index++; continue; }
      if (char === "{") depth++;
      else if (char === "}") depth--;
      else if ((char === '"' || char === "'" || char === "`") && (depth > 0 || char === '"')) quote = char;
      else if (char === ">" && depth === 0) break;
    }
    tags.push(source.slice(start.index, index + 1));
  }
  return tags;
}
// Lightboxes are full-screen media viewers, not header/body/footer dialogs; everything else uses DialogFrame/ConfirmDialog.
const rawDialogAllowed = new Set(["src/renderer/src/ui/ConfirmDialog.jsx", "src/renderer/src/ChatImageViewer.jsx", "src/renderer/src/features/workflow/WorkflowImagePreview.jsx"]);
for (const file of files) {
  const repoPath = toRepoPath(file);
  if (!repoPath.startsWith("src/renderer/")) continue;
  const source = await readFile(file, "utf8");
  if (source.includes("workflow-primary")) designViolations.push(`${repoPath} uses workflow-primary; use the shared "primary" class`);
  if (!file.endsWith(".jsx") || repoPath.startsWith("src/renderer/src/ui/")) continue;
  // Pages and features use <Button variant="primary">; a raw <button className="primary"> skips the shared states (busy, disabled reason).
  for (const tag of jsxOpeningTags(source, "button")) {
    if (/className=(?:"[^"]*\bprimary\b|\{[^]*?["'`][^"'`]*\bprimary\b)/.test(tag)) designViolations.push(`${repoPath} has a raw primary <button>; use <Button variant="primary"> from ui/: ${tag.slice(0, 80)}`);
  }
  if (!rawDialogAllowed.has(repoPath) && /<Dialog[\s>]/.test(source)) designViolations.push(`${repoPath} renders <Dialog> directly; use DialogFrame or ConfirmDialog from ui/`);
}
if (designViolations.length) {
  console.error("Design-system violations:");
  for (const violation of designViolations) console.error(`- ${violation}`);
  process.exitCode = 1;
}

if (violations.length) {
  console.error("Architecture boundary violations:");
  for (const violation of violations) {
    console.error(
      `- ${violation.file} imports ${violation.specifier} (${violation.importPath}): ${violation.message}`,
    );
  }
  process.exitCode = 1;
}
