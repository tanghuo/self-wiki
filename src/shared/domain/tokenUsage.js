// Provider counters are authoritative; absent counters stay unknown.
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
export function tokenUsage(value) {
  const input = count(value?.inputTokens ?? value?.input_tokens ?? value?.prompt_tokens);
  const output = count(value?.outputTokens ?? value?.output_tokens);
  return { input, output, cached: count(value?.cachedInputTokens ?? value?.cached_input_tokens ?? value?.input_tokens_details?.cached_tokens),
    reasoning: count(value?.reasoningOutputTokens ?? value?.output_tokens_details?.reasoning_tokens),
    total: count(value?.totalTokens ?? value?.total_tokens) ?? (input !== null && output !== null ? input + output : null) };
}

// Start with the latest request; subsequent cumulative snapshots add only their delta.
export function accumulateTurnUsage(previous, snapshot) {
  const total = tokenUsage(snapshot?.total), last = tokenUsage(snapshot?.last), sum = {};
  for (const key of ["input", "output", "cached", "reasoning", "total"]) {
    const delta = previous && total[key] !== null && previous.total[key] !== null && total[key] >= previous.total[key]
      ? total[key] - previous.total[key] : last[key];
    sum[key] = delta === null ? previous?.sum[key] ?? null : (previous?.sum[key] ?? 0) + delta;
  }
  return { total, sum, usage: { inputTokens: sum.input, outputTokens: sum.output, cachedInputTokens: sum.cached,
    reasoningOutputTokens: sum.reasoning, totalTokens: sum.total } };
}
