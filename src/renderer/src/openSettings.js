/** Open the settings dialog at an optional section id (e.g. "video", "sharing"). */
export function openSettings(section = "general") {
  window.dispatchEvent(new CustomEvent("self-wiki-open-settings", { detail: { section } }));
}
