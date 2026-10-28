// Helpers for the styled dropdown (src/renderer/src/Select.jsx), which replaces native <select>s.
export async function chooseOption(scope, label, value) {
  const box = scope.getByRole("combobox", { name: label, exact: true });
  await box.click();
  const list = scope.locator(`[role="listbox"][aria-label=${JSON.stringify(`${label}选项`)}]`);
  const byValue = list.locator(`[role="option"][data-value=${JSON.stringify(String(value))}]`);
  if (await byValue.count()) await byValue.click();
  else await list.getByRole("option", { name: String(value), exact: true }).click();
  await list.waitFor({ state: "detached" });
}

export function selectedValue(scope, label) {
  // The session picker is hidden on the full Agent page, so locate by attribute rather than by role.
  return scope.locator(`[role="combobox"][aria-label=${JSON.stringify(label)}]`).getAttribute("data-value");
}

// The library's secondary view options (layout, image size, stacking, material filter) sit in the 视图 popover.
export async function openViewMenu(page) {
  const trigger = page.locator(".wiki-view-menu-trigger");
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
}

// Less frequent detail actions (wallpaper, move to trash) sit in the detail page's … menu.
export async function openDetailMenu(page) {
  const menu = page.locator("details.wiki-detail-menu");
  if (!await menu.evaluate((node) => node.open)) await menu.locator("summary").click();
}

export async function closeViewMenu(page) {
  const trigger = page.locator(".wiki-view-menu-trigger");
  if (await trigger.getAttribute("aria-expanded") === "true") await trigger.click();
}

export async function openRelationAdvanced(scope) {
  const more = scope.getByRole("button", { name: "更多选项", exact: true });
  if (await more.getAttribute("aria-pressed") !== "true") await more.click();
}
