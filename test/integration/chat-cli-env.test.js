import { test } from "node:test";
import assert from "node:assert/strict";
import { cliBaseEnvironment } from "../../src/server/application/chatService.js";

test("the chat library CLI inherits only OS basics, not the user's secrets", () => {
  const env = cliBaseEnvironment({ Path: "C:\\bin", SystemRoot: "C:\\Windows", HOME: "/home/u", LANG: "zh_CN.UTF-8",
    OPENAI_API_KEY: "sk-secret", GITHUB_TOKEN: "ghp", AWS_SECRET_ACCESS_KEY: "x", SELF_WIKI_CHAT_TOKEN: "stale", NODE_OPTIONS: "--require evil.js" });
  assert.deepEqual(env, { Path: "C:\\bin", SystemRoot: "C:\\Windows", HOME: "/home/u", LANG: "zh_CN.UTF-8" });
});
