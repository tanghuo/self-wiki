#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile, open, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { commands, globalOptions, schema } from "./commands.js";
import { CliError, connect } from "./client.js";
import { maxImageBytes, maxVideoBytes } from "../shared/domain/elements.js";

const usage = (message) => { throw new CliError("USAGE", message, 2); };

function selectCommand(args) {
  const command = commands.find((entry) => entry.name.split(" ").every((word, index) => args[index] === word));
  if (!command) usage(`Unknown command: ${args.join(" ")}. Run --help or schema.`);
  return command;
}

function parseCommand(command, args) {
  const specs = { ...globalOptions, ...command.options };
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, tokens: true,
      options: Object.fromEntries(Object.entries(specs).map(([key, spec]) => [key, { type: spec.type, multiple: Boolean(spec.multiple) }])) });
  } catch (error) { usage(error.message); }
  const { values, positionals, tokens } = parsed;
  for (const [key, spec] of Object.entries(specs)) {
    const present = values[key] !== undefined;
    if (tokens.filter((token) => token.kind === "option" && token.name === key).length > 1 && !spec.multiple) usage(`--${key} may only be supplied once`);
    if (!values.help && spec.required && !present) usage(`--${key} is required`);
    if (!present) continue;
    if (spec.integer) {
      if (!/^\d+$/.test(values[key]) || !Number.isSafeInteger(Number(values[key])) || Number(values[key]) < spec.min || Number(values[key]) > spec.max) usage(`--${key} must be an integer between ${spec.min} and ${spec.max}`);
      values[key] = Number(values[key]);
    }
    if (spec.choices && !spec.choices.includes(values[key])) usage(`--${key} must be one of: ${spec.choices.join(", ")}`);
  }
  if (!values.help && positionals.length !== (command.args || []).length) usage(`Expected: ${command.name} ${(command.args || []).map((arg) => `<${arg}>`).join(" ")}`);
  const positional = Object.fromEntries((command.args || []).map((name, index) => [name, positionals[index]]));
  if (positional.id !== undefined && !/^[1-9]\d*$/.test(positional.id)) usage("ID must be a positive integer");
  if (positional.id !== undefined && !Number.isSafeInteger(Number(positional.id))) usage("ID is too large");
  return { values, positional };
}

function help(selected = commands) {
  return ["self-wiki <command> [arguments] [options]", "Commands must come before options. JSON output is the default; no server is needed for help/schema.", "",
    ...selected.flatMap((command) => [
      `${command.name} ${(command.args || []).map((arg) => `<${arg}>`).join(" ")}  ${command.description}`,
      ...Object.entries(command.options || {}).map(([name, spec]) => `  --${name}${spec.type === "string" ? " <value>" : ""}  ${spec.description}`),
    ]), "", "Global options:", ...Object.entries(globalOptions).map(([name, spec]) => `  --${name}  ${spec.description}`),
    "", "self-wiki schema [command]  Machine-readable command catalogue and semantics", "See docs/cli.md for payload formats and agent workflows.", ""].join("\n");
}

async function readText(file) {
  if (file !== "-") return (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
  if (process.stdin.isTTY) usage("'-' requires piped stdin; use a file path for interactive terminals");
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
}

async function jsonInput(options, required = true) {
  if (options.input !== undefined && options.data !== undefined) usage("Use only one of --input and --data");
  if (options.input === undefined && options.data === undefined) {
    if (required) usage("Provide a JSON object using --input <file|-> or --data <json>");
    return undefined;
  }
  const text = options.input === undefined ? options.data : await readText(options.input);
  let value;
  try { value = JSON.parse(text); } catch { usage("Input must be valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) usage("Input must be a JSON object");
  return value;
}

function ids(value) {
  const entries = value.split(",");
  if (!entries.length || entries.length > 100 || entries.some((entry) => !/^[1-9]\d*$/.test(entry) || !Number.isSafeInteger(Number(entry)))) usage("--ids must contain 1–100 comma-separated positive integer IDs");
  return entries.map(Number);
}

async function prepare(command, options, positional) {
  const prepared = { method: command.method || "GET" };
  let payload;
  switch (command.action) {
    case "videoAnalysis": payload = { restart: Boolean(options.restart) }; break;
    case "organizationEnqueue": payload = { elementId: Number(positional.id) }; break;
    case "content": {
      payload = await jsonInput(options, false);
      const hasFields = ["body", "body-file", "tag"].some((key) => options[key] !== undefined);
      if (payload && hasFields) usage("Do not combine JSON input with --body, --body-file or --tag");
      if (!payload) {
        if (options.body !== undefined && options["body-file"] !== undefined) usage("Use only one of --body and --body-file");
        payload = {};
        if (options.body !== undefined) payload.body = options.body;
        if (options["body-file"] !== undefined) payload.body = await readText(options["body-file"]);
        if (options.tag !== undefined) payload.tags = options.tag;
      }
      if (!Object.keys(payload).length) usage("Supply text or tags to write");
      break;
    }
    case "input": payload = await jsonInput(options); break;
    case "relationName": payload = { name: options.name, direction: options.direction, reverseName: options["reverse-name"] }; break;
    case "name": payload = { name: options.name }; break;
    case "relation":
      payload = { sourceId: options.source, targetId: options.target, name: options.name, type: options.type, direction: options.direction, reverseName: options["reverse-name"] }; break;
    case "purge":
      if (!options.yes) usage("Permanent deletion requires --yes after reviewing the trash contents");
      if (Boolean(options.all) === (options.ids !== undefined)) usage("Provide exactly one of --ids or --all");
      payload = options.all ? { all: true } : { ids: ids(options.ids) }; break;
    case "sharing": payload = { enabled: command.value }; break;
    case "image": {
      const info = await stat(positional.file);
      if (!info.isFile() || info.size > maxImageBytes) usage("Image must be a file no larger than 25 MiB");
      prepared.body = await readFile(positional.file);
      if (prepared.body.length > maxImageBytes) usage("Image must be no larger than 25 MiB");
      prepared.headers = { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(path.basename(positional.file)), "x-image-tags": Buffer.from(JSON.stringify(options.tag || [])).toString("base64") };
      break;
    }
    case "video": {
      const info = await stat(positional.file);
      if (!info.isFile() || !info.size || info.size > maxVideoBytes) usage("Video must be a nonempty file no larger than 1 GiB");
      prepared.file = positional.file;
      prepared.headers = { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(path.basename(positional.file)), "x-video-tags": Buffer.from(JSON.stringify(options.tag || [])).toString("base64") };
      break;
    }
    case "download": prepared.format = "stream"; break;
  }
  if (payload !== undefined || ["POST", "PATCH", "PUT"].includes(prepared.method) && !["image", "video"].includes(command.action)) {
    prepared.body = JSON.stringify(payload || {});
    if (Buffer.byteLength(prepared.body) > 64 * 1024) usage("JSON request body exceeds 64 KiB");
    prepared.headers = { "content-type": "application/json" };
  }
  return prepared;
}

async function saveDownload(body, output) {
  let handle;
  try { handle = await open(output, "wx"); }
  catch (error) { await body.cancel().catch(() => {}); throw error; }
  const destination = handle.createWriteStream();
  try {
    await pipeline(async function* () {
      try { yield* body; }
      catch (error) { throw new CliError("CONNECTION", `Download failed: ${error.message}. Check that the backend is running.`, 3); }
    }(), destination);
    return { path: output, bytes: destination.bytesWritten };
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(output, { force: true });
    throw error;
  }
}

function routeFor(command, options, positional) {
  const route = (command.route || "").replace(":id", positional.id);
  if (command.method !== "GET") return route;
  const query = new URLSearchParams();
  const names = { "page-size": "pageSize", "group-ids": "groupIds", "element-id": "elementId", "video-id": "videoId", "frame-id": "frameId" };
  for (const key of Object.keys(command.options || {})) {
    if (options[key] !== undefined && key !== "output") query.set(names[key] || key, options[key]);
  }
  return `${route}${query.size ? `?${query}` : ""}`;
}

async function execute(command, options, positional) {
  // Validate and read local inputs before making any request, especially before a mutation.
  const prepared = await prepare(command, options, positional);
  const client = await connect(options);
  if (command.action === "status") return { instance: client.instance };
  if (command.action === "read") {
    const root = `/api/elements/${positional.id}`;
    const query = new URLSearchParams({ page: String(options.page || 1), pageSize: String(options["page-size"] || 36) });
    const [element, relations, tagRelations] = await Promise.all([client.request(root), client.request(`${root}/relations?${query}`), client.request(`${root}/tag-relations`)]);
    return { element, relations, tagRelations: tagRelations.tagRelations };
  }
  if (prepared.file) prepared.body = createReadStream(prepared.file);
  let result;
  try { result = await client.request(routeFor(command, options, positional), prepared); }
  finally { if (prepared.file) prepared.body.destroy(); }
  if (command.action === "download") {
    return saveDownload(result, path.resolve(options.output));
  }
  if (command.action === "purge" && (result.failed?.length || result.cleanupFailed?.length || result.historyCleanupFailed?.length)) {
    throw new CliError("PARTIAL_FAILURE", "Some trash records or files could not be deleted; inspect details before retrying", 1, result);
  }
  return result;
}

export async function main(args = process.argv.slice(2)) {
  let pretty = args.includes("--pretty");
  try {
    if (!args.length || args.length === 1 && ["--help", "-h", "help"].includes(args[0])) { process.stdout.write(help()); return 0; }
    if (args[0] === "help") args = [...args.slice(1), "--help"];
    if (args[0] === "schema") {
      const names = args.slice(1).filter((arg) => !["--pretty", "--json"].includes(arg));
      const selected = names.length ? commands.filter((entry) => entry.name === names.join(" ") || entry.name.startsWith(`${names.join(" ")} `)) : commands;
      if (!selected.length) usage("Unknown schema command");
      process.stdout.write(`${JSON.stringify({ ok: true, data: schema(selected) }, null, pretty ? 2 : undefined)}\n`);
      return 0;
    }
    const group = commands.filter((entry) => entry.name.startsWith(`${args[0]} `));
    if (group.length && (args.length === 1 || args.length === 2 && args[1] === "--help")) { process.stdout.write(help(group)); return 0; }
    const command = selectCommand(args);
    const { values, positional } = parseCommand(command, args.slice(command.name.split(" ").length));
    pretty = values.pretty;
    if (values.help) { process.stdout.write(help([command])); return 0; }
    const data = await execute(command, values, positional);
    process.stdout.write(`${JSON.stringify({ ok: true, data }, null, pretty ? 2 : undefined)}\n`);
    return 0;
  } catch (error) {
    const failure = error instanceof CliError ? error : new CliError("IO_ERROR", error.message);
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message, status: failure.status, details: failure.details } }, null, pretty ? 2 : undefined)}\n`);
    return failure.exitCode;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
