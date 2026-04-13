#!/usr/bin/env node
// Send a message to a specific Discord thread
// Usage: DISCORD_TEST_BOT_TOKEN=... node scripts/send-to-thread.mjs <threadId> "message"

const token = process.env.DISCORD_TEST_BOT_TOKEN;
if (!token) { console.error('Missing DISCORD_TEST_BOT_TOKEN'); process.exit(1); }

const [threadId, ...msgParts] = process.argv.slice(2);
if (!threadId || !msgParts.length) { console.error('Usage: send-to-thread.mjs <threadId> "message"'); process.exit(1); }

const content = msgParts.join(' ');
const BASE = 'https://discord.com/api/v10';
const headers = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };

const res = await fetch(`${BASE}/channels/${threadId}/messages`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ content }),
});

if (!res.ok) {
  const err = await res.json().catch(() => ({}));
  console.error('Send failed:', res.status, JSON.stringify(err));
  process.exit(1);
}

const m = await res.json();
console.log(`✓ Sent to thread ${threadId} (msg ${m.id})`);
