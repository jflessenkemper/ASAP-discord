// Fast clean: delete all goal threads, then bulk-purge main channel messages
const token = process.env.DISCORD_TEST_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
if (!token || !guildId) { console.error('Missing DISCORD_TEST_BOT_TOKEN or DISCORD_GUILD_ID'); process.exit(1); }

const BASE = 'https://discord.com/api/v10';
const headers = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function api(path, opts = {}) {
  for (let i = 0; i < 8; i++) {
    const res = await fetch(`${BASE}${path}`, { ...opts, headers });
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      await sleep(Math.ceil((body.retry_after || 2) * 1000) + 300);
      continue;
    }
    return res;
  }
  return null;
}

// 1. Delete all active threads (goal threads etc.)
console.log('Phase 1: Deleting active threads...');
const threadsRes = await api(`/guilds/${guildId}/threads/active`);
const threadsData = await threadsRes.json();
const threads = threadsData?.threads || [];
let threadsDel = 0;
for (const t of threads) {
  const r = await api(`/channels/${t.id}`, { method: 'DELETE' });
  if (r && (r.ok || r.status === 404)) threadsDel++;
  if (threadsDel % 10 === 0) process.stdout.write('.');
}
console.log(`\n  Deleted ${threadsDel}/${threads.length} threads`);

// 2. Clean main text channels
console.log('Phase 2: Cleaning text channels...');
const chRes = await api(`/guilds/${guildId}/channels`);
const channels = (await chRes.json()).filter(c => [0, 5].includes(c.type));
let totalMsgs = 0;

for (const ch of channels) {
  let deleted = 0;
  let before;
  for (let pass = 0; pass < 10; pass++) {
    const qs = new URLSearchParams({ limit: '100' });
    if (before) qs.set('before', before);
    const listRes = await api(`/channels/${ch.id}/messages?${qs}`);
    if (!listRes?.ok) break;
    const msgs = await listRes.json();
    if (!Array.isArray(msgs) || msgs.length === 0) break;
    before = msgs[msgs.length - 1]?.id;
    if (!before) break;

    // Try bulk delete (messages < 14 days old, 2-100 at a time)
    const now = Date.now();
    const twoWeeksMs = 14 * 24 * 60 * 60 * 1000;
    const recent = msgs.filter(m => now - new Date(m.timestamp).getTime() < twoWeeksMs);
    const old = msgs.filter(m => now - new Date(m.timestamp).getTime() >= twoWeeksMs);

    if (recent.length >= 2) {
      const bulkRes = await api(`/channels/${ch.id}/messages/bulk-delete`, {
        method: 'POST',
        body: JSON.stringify({ messages: recent.map(m => m.id) }),
      });
      if (bulkRes?.ok) { deleted += recent.length; totalMsgs += recent.length; }
    } else if (recent.length === 1) {
      const r = await api(`/channels/${ch.id}/messages/${recent[0].id}`, { method: 'DELETE' });
      if (r?.ok || r?.status === 404) { deleted++; totalMsgs++; }
    }

    for (const m of old) {
      const r = await api(`/channels/${ch.id}/messages/${m.id}`, { method: 'DELETE' });
      if (r?.ok || r?.status === 404) { deleted++; totalMsgs++; }
    }
  }
  if (deleted > 0) console.log(`  #${ch.name}: ${deleted} messages`);
}

console.log(`\nDone: ${threadsDel} threads deleted, ${totalMsgs} messages from ${channels.length} channels`);
