/**
 * Warm outbound LLM connections at bot startup so the first real user turn
 * finds a hot TCP/TLS pool and (for Anthropic) a primed prompt cache.
 *
 * Cost: one tiny Haiku completion (~$0.0001) per boot. Disable by setting
 * `BOT_WARM_ANTHROPIC=false` if boots are frequent enough to matter.
 *
 * We deliberately keep this cheap and best-effort — a failed warm-up must
 * never prevent the bot from reaching ClientReady.
 */

import { errMsg } from '../utils/errors';

const WARM_ENABLED = String(process.env.BOT_WARM_ANTHROPIC || 'true').toLowerCase() !== 'false';
const WARM_MODEL = process.env.BOT_WARM_ANTHROPIC_MODEL || 'claude-haiku-4-5';
const WARM_TIMEOUT_MS = Math.max(2000, parseInt(process.env.BOT_WARM_TIMEOUT_MS || '8000', 10));

/**
 * Fire a minimal Anthropic completion to prime the connection pool + warm
 * cache. Returns silently — success is seen via faster subsequent turns.
 */
export async function warmAnthropicConnection(): Promise<void> {
  if (!WARM_ENABLED) return;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), WARM_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: WARM_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: controller.signal,
    });
    if (res.ok) {
      console.log(`[warm] Anthropic connection primed (${WARM_MODEL})`);
    } else {
      // 4xx/5xx still means the TCP pool is warm — don't fuss.
      console.log(`[warm] Anthropic probe returned ${res.status} — connection still pooled`);
    }
  } catch (err) {
    console.warn('[warm] Anthropic probe failed:', errMsg(err));
  } finally {
    clearTimeout(t);
  }
}
