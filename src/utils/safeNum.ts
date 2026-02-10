/** Guard against NaN/undefined — return 0 for display */
export function safeNum(n: number | undefined): number {
  return n != null && !Number.isNaN(n) ? n : 0;
}
