/**
 * Shared regex for detecting low-signal completion responses like "Done.", "Fixed.", etc.
 * Used by claude.ts (response normalization), groupchat.ts (quality gate), and textChannel.ts (display).
 */
export const LOW_SIGNAL_COMPLETION_RE = /^\s*(?:done|fixed|resolved|completed|all good|finished)\.?\s*$/i;

/**
 * Returns true if the text is a low-signal completion phrase (e.g. "Done.", "Fixed.", "Completed")
 * that should be normalized or retried depending on context.
 */
export function isLowSignalCompletion(text: string): boolean {
  return LOW_SIGNAL_COMPLETION_RE.test(text);
}
