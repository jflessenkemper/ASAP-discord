/**
 * Shared helpers for identifying the bot's own token and recognizing the
 * dedicated tester bot account used by the smoke harness.
 *
 * Previously duplicated across bot.ts, handlers/callSession.ts,
 * handlers/groupchat.ts, and voice/connection.ts. Single source now.
 */

const DEFAULT_TESTER_BOT_ID = '1487426371209789450';

/**
 * Extract the Discord bot user id from a bot token. Tokens are dot-separated
 * and the first segment is base64 of the user id. Returns null if the shape
 * doesn't look like a Discord bot token.
 */
export function decodeBotIdFromToken(token: string): string | null {
  try {
    const head = String(token || '').split('.')[0];
    if (!head) return null;
    const normalized = head.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8').trim();
    return /^\d{16,22}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * True if the given Discord user id belongs to the project's tester bot.
 * The allowed set is DEFAULT_TESTER_BOT_ID plus any comma-separated ids in
 * DISCORD_TESTER_BOT_ID plus whatever id is encoded inside
 * DISCORD_TEST_BOT_TOKEN (if set).
 */
export function isTesterBotId(userId: string): boolean {
  const configured = String(process.env.DISCORD_TESTER_BOT_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const tokenDerived = decodeBotIdFromToken(process.env.DISCORD_TEST_BOT_TOKEN || '');
  const allowed = new Set([DEFAULT_TESTER_BOT_ID, ...configured, ...(tokenDerived ? [tokenDerived] : [])]);
  return allowed.has(userId);
}
