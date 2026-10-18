import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOrganizationService } from "../src/server/application/organizationService.js";
import { createChatService } from "../src/server/application/chatService.js";
import { defaultOrganizationConfig } from "../src/shared/domain/organization.js";

test("chat reads isolated execution settings without querying organization or semantic status", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-chat-config-"));
  let organization, chat;
  t.after(async () => {
    await chat?.close(); await organization?.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("wiki-chat-config-"));
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const config = defaultOrganizationConfig();
  config.executor.codexCli.executable = path.join(dir, "app-server.mjs");
  config.executor.codexCli.codexHome = path.join(dir, "custom-codex");
  await writeFile(config.executor.codexCli.executable, await readFile(new URL("./fixtures/chat-app-server.txt", import.meta.url)));
  await writeFile(path.join(dir, "organization.json"), JSON.stringify(config));
  const unexpectedStatus = () => assert.fail("Model discovery must not query unrelated job/index status");
  organization = await createOrganizationService({ dataDir: dir,
    repo: { configure() {}, status: unexpectedStatus },
    semantic: { configure() {}, status: unexpectedStatus, close() {} } });
  const snapshot = organization.executionConfig();
  assert.equal(snapshot.codexCli.codexHome, config.executor.codexCli.codexHome);
  assert.equal(snapshot.codexCli.reuseLocalAuth, false);
  snapshot.codexCli.executable = "changed-by-caller";
  snapshot.imageGeneration.chatgptWeb.profile = "changed-by-caller";
  assert.equal(organization.executionConfig().codexCli.executable, config.executor.codexCli.executable);
  assert.equal(organization.executionConfig().imageGeneration.chatgptWeb.profile, config.imageGeneration.chatgptWeb.profile);
  chat = createChatService({ organization, dataDir: dir, repo: { recover() {} }, archive: { recoverPrompts() {} } });
  const result = await chat.models();
  assert.ok(result.models.length > 0);
  assert.equal(chat.status().available, true);
});
