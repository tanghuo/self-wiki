import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(projectRoot, "src");

const rules = [
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

if (violations.length) {
  console.error("Architecture boundary violations:");
  for (const violation of violations) {
    console.error(
      `- ${violation.file} imports ${violation.specifier} (${violation.importPath}): ${violation.message}`,
    );
  }
  process.exitCode = 1;
}
