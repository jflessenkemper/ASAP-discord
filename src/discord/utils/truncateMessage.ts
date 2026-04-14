/**
 * Safely truncate a string to fit within Discord's message limit.
 *
 * - Breaks at the last word boundary before `maxLength`.
 * - Appends a configurable suffix (default "…") when the string is truncated.
 * - Returns the original string untouched if it already fits.
 */

const DISCORD_MAX = 2000;

export interface TruncateOptions {
  /** Maximum character length (including suffix). Defaults to 2000. */
  maxLength?: number;
  /** String appended when truncation occurs. Defaults to "…" */
  suffix?: string;
}

export function truncateMessage(
  text: string,
  options: TruncateOptions = {},
): string {
  const { maxLength = DISCORD_MAX, suffix = '…' } = options;

  if (maxLength < 1) {
    throw new RangeError('maxLength must be at least 1');
  }

  if (text.length <= maxLength) {
    return text;
  }

  const budget = maxLength - suffix.length;
  if (budget <= 0) {
    // suffix itself exceeds maxLength — return truncated suffix
    return suffix.slice(0, maxLength);
  }

  // Slice to budget, then try to break at the last whitespace
  const slice = text.slice(0, budget);
  const lastSpace = slice.lastIndexOf(' ');

  // If there's a reasonable word boundary (at least 20% into the slice), use it
  const breakAt = lastSpace > budget * 0.2 ? lastSpace : budget;

  return text.slice(0, breakAt).trimEnd() + suffix;
}

export default truncateMessage;
