/** Extract a human-readable message from an unknown caught value. */
export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  const s = String(err ?? '');
  return s || 'Unknown';
}
