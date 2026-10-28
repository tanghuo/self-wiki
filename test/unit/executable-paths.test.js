import { test } from "node:test";
import assert from "node:assert/strict";
import { isNetworkPath, validExecutable } from "../../src/shared/domain/executablePath.js";
import { defaultOrganizationConfig, organizationConfig } from "../../src/shared/domain/organization.js";
import { defaultVideoAnalysisConfig, videoAnalysisConfig } from "../../src/shared/domain/videoAnalysis.js";
import { defaultImageGenerationConfig, imageGenerationConfig } from "../../src/shared/domain/imageGeneration.js";
import { comfyuiConfig } from "../../src/shared/domain/comfyui.js";

const networkPaths = ["\\\\server\\share\\codex.exe", "//server/share/codex", "\\\\?\\UNC\\server\\share\\x.exe", "  \\\\server\\share\\x.exe", "\\/server/x"];
const localPaths = ["codex", "C:\\Tools\\codex.exe", "C:/Tools/ffmpeg.exe", "/usr/local/bin/ffmpeg", "tools\\python.exe"];

test("executable paths reject UNC and other network paths", () => {
  for (const value of networkPaths) {
    assert.equal(isNetworkPath(value), true, value);
    assert.equal(validExecutable(value), false, value);
  }
  for (const value of localPaths) assert.equal(validExecutable(value), true, value);
  for (const value of ["", "   ", "a\nb", "a\0b", null, 3]) assert.equal(validExecutable(value), false, String(value));
});

test("organization, image generation and video analysis configs refuse network executables", () => {
  for (const value of networkPaths) {
    const organization = defaultOrganizationConfig();
    organization.executor.codexCli.executable = value;
    assert.throws(() => organizationConfig(organization), /网络路径/, value);
    const images = defaultImageGenerationConfig();
    images.chatgptWeb.python = value;
    assert.throws(() => imageGenerationConfig(images), /网络路径/, value);
    const browser = defaultImageGenerationConfig();
    browser.chatgptWeb.browser = value;
    assert.throws(() => imageGenerationConfig(browser), /网络路径/, value);
    for (const name of ["ffmpeg", "ffprobe"]) {
      const video = defaultVideoAnalysisConfig();
      video[name] = value;
      assert.throws(() => videoAnalysisConfig(video), /网络路径/, `${name} ${value}`);
    }
  }
  const organization = defaultOrganizationConfig();
  organization.executor.codexCli.executable = "C:\\Tools\\codex.exe";
  assert.equal(organizationConfig(organization).executor.codexCli.executable, "C:\\Tools\\codex.exe");
  const video = defaultVideoAnalysisConfig();
  video.ffmpeg = "/usr/bin/ffmpeg";
  assert.equal(videoAnalysisConfig(video).ffmpeg, "/usr/bin/ffmpeg");
});

test("ComfyUI base URL only accepts plain HTTP(S) addresses", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://127.0.0.1:8188", "javascript:alert(1)", "http://user:pass@127.0.0.1:8188", "http://127.0.0.1:8188/?q=1", "not a url"]) {
    assert.throws(() => comfyuiConfig({ baseUrl, workflowName: "", workflow: null, prompt: null, outputNodeId: "" }), undefined, baseUrl);
  }
  assert.equal(comfyuiConfig({ baseUrl: "https://comfy.local:8188/", workflowName: "", workflow: null, prompt: null, outputNodeId: "" }).baseUrl, "https://comfy.local:8188");
});
