const codes = { symmetric: 0, forward: 1, reverse: -1, unknown: 2 };
export function storedDirection(direction = "symmetric", swapped = false) {
  const code = codes[direction];
  return swapped && Math.abs(code) === 1 ? -code : code;
}
export function relationDirection(row) {
  return { direction: Object.keys(codes).find((key) => codes[key] === row.direction) || "symmetric", reverseName: row.reverse_name || "" };
}
