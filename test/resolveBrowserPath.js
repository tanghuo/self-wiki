import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

/** Resolve a Chromium/Chrome/Edge binary for Playwright UI tests. */
export function resolveBrowserPath() {
  return [
    process.env.RENDERER_BROWSER_PATH,
    chromium.executablePath(),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((file) => file && existsSync(file));
}
