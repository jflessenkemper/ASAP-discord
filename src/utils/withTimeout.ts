/**
 * Race a promise against a timeout. Resolves with the promise result if it
 * finishes first, rejects with a labeled error otherwise. Clears the timer
 * either way so we never leak one.
 *
 * Previously duplicated across callSession.ts (with label),
 * discordOutputSanitizer.ts (without label), and voice/elevenlabsConvai.ts.
 * The `label` parameter is optional so callers that don't care can omit it.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label?: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      const msg = label ? `${label} timed out after ${timeoutMs}ms` : `Operation timed out after ${timeoutMs}ms`;
      reject(new Error(msg));
    }, timeoutMs);
    promise.then(
      (value) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      },
    );
  });
}
