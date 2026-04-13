#!/usr/bin/env node
// Chat with Riley via Discord REST API using the tester bot
// Usage: node scripts/riley-chat.mjs "your message here"
//   or:  node scripts/riley-chat.mjs --poll           (poll for new messages)
//   or:  node scripts/riley-chat.mjs --history 20     (show last N messages)
//   or:  node scripts/riley-chat.mjs --find-channel    (find the groupchat channel ID)

const token = process.env.DISCORD_TEST_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
if (!token || !guildId) { console.error('Missing DISCORD_TEST_BOT_TOKEN or DISCORD_GUILD_ID'); process.exit(1); }

const BASE = 'https://discord.com/api/v10';
const headers = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function api(path, opts = {}) {
  for (let i = 0; i < 5; i++) {
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

// Find #groupchat channel
async function findGroupchat() {
  const res = await api(`/guilds/${guildId}/channels`);
  const channels = await res.json();
  return channels.find(c => c.name?.includes('groupchat') && c.type === 0);
}

// Send a message
async function sendMessage(channelId, content) {
  const res = await api(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
  if (!res?.ok) {
    const err = await res?.json().catch(() => ({}));
    console.error('Send failed:', err);
    return null;
  }
  const msg = await res.json();
  console.log(`✓ Sent (${msg.id}): ${content.slice(0, 80)}...`);
  return msg;
}

// Get recent messages
async function getMessages(channelId, limit = 20, after = null) {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (after) qs.set('after', after);
  const res = await api(`/channels/${channelId}/messages?${qs}`);
  if (!res?.ok) return [];
  const msgs = await res.json();
  return msgs.reverse(); // oldest first
}

// Format message for display
function fmtMsg(m) {
  const who = m.author?.username || 'unknown';
  const isBot = m.author?.bot ? ' [BOT]' : '';
  const time = new Date(m.timestamp).toLocaleTimeString('en-AU', { hour12: false });
  const content = m.content?.slice(0, 300) || '';
  const embeds = m.embeds?.length ? ` [+${m.embeds.length} embed(s)]` : '';
  return `[${time}] ${who}${isBot}: ${content}${embeds}`;
}

// Also check threads spawned from the channel
async function getActiveThreads() {
  const res = await api(`/guilds/${guildId}/threads/active`);
  if (!res?.ok) return [];
  const data = await res.json();
  return data.threads || [];
}

const args = process.argv.slice(2);
const cmd = args[0];

const ch = await findGroupchat();
if (!ch) { console.error('Could not find #groupchat channel'); process.exit(1); }

if (cmd === '--find-channel') {
  console.log(`Channel: #${ch.name} (${ch.id})`);
  process.exit(0);
}

if (cmd === '--history') {
  const n = parseInt(args[1]) || 20;
  const msgs = await getMessages(ch.id, n);
  for (const m of msgs) console.log(fmtMsg(m));
  process.exit(0);
}

if (cmd === '--poll') {
  // Poll for new messages from Riley's goal threads too
  const afterId = args[1] || null;
  console.log('Polling for messages' + (afterId ? ` after ${afterId}` : '') + '...');
  
  // Check groupchat
  const msgs = await getMessages(ch.id, 30, afterId);
  if (msgs.length) {
    console.log(`\n--- #${ch.name} ---`);
    for (const m of msgs) console.log(fmtMsg(m));
  }
  
  // Check active threads for goal threads
  const threads = await getActiveThreads();
  const goalThreads = threads.filter(t => t.name?.startsWith('Goal-'));
  if (goalThreads.length) {
    // Show most recent goal thread messages
    const sorted = goalThreads.sort((a, b) => b.id.localeCompare(a.id));
    for (const t of sorted.slice(0, 3)) {
      const tMsgs = await getMessages(t.id, 10);
      if (tMsgs.length) {
        console.log(`\n--- ${t.name} ---`);
        for (const m of tMsgs) console.log(fmtMsg(m));
      }
    }
  }
  
  // Also check #terminal for tool audit events
  const allChannels = await api(`/guilds/${guildId}/channels`);
  const channels = await allChannels.json();
  const terminal = channels.find(c => c.name?.includes('terminal') && c.type === 0);
  if (terminal) {
    const tMsgs = await getMessages(terminal.id, 5);
    if (tMsgs.length) {
      console.log(`\n--- #${terminal.name} ---`);
      for (const m of tMsgs) console.log(fmtMsg(m));
    }
  }
  
  process.exit(0);
}

if (cmd === '--watch') {
  // Continuously watch for new messages
  const duration = parseInt(args[1]) || 300; // seconds
  let lastId = null;
  
  // Get current last message ID
  const initial = await getMessages(ch.id, 1);
  if (initial.length) lastId = initial[initial.length - 1].id;
  
  console.log(`Watching #${ch.name} for ${duration}s... (last msg: ${lastId})`);
  const deadline = Date.now() + duration * 1000;
  
  while (Date.now() < deadline) {
    await sleep(3000);
    
    // Check groupchat
    const msgs = await getMessages(ch.id, 10, lastId);
    for (const m of msgs) {
      console.log(fmtMsg(m));
      lastId = m.id;
    }
    
    // Check latest goal thread
    const threads = await getActiveThreads();
    const goalThreads = threads.filter(t => t.name?.startsWith('Goal-')).sort((a, b) => b.id.localeCompare(a.id));
    if (goalThreads.length) {
      const latest = goalThreads[0];
      const tMsgs = await getMessages(latest.id, 5);
      const newMsgs = tMsgs.filter(m => !lastId || m.id > lastId);
      for (const m of newMsgs) {
        console.log(`[${latest.name}] ${fmtMsg(m)}`);
      }
    }
  }
  console.log('Watch ended.');
  process.exit(0);
}

// Default: send a message
if (!cmd) { console.error('Usage: node riley-chat.mjs "message" | --poll | --history N | --watch [seconds]'); process.exit(1); }

const message = args.join(' ');
await sendMessage(ch.id, message);
