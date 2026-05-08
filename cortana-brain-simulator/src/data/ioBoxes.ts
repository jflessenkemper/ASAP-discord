// I/O boxes — sensory & motor cubes attached to the brain. Each is a single
// cube; clicking opens a detail panel describing how Cortana uses Discord
// for that channel.

export type IOBoxId = 'eye_left' | 'eye_right' | 'ear_left' | 'ear_right' | 'mouth' | 'spine';
export type IOBoxKind = 'eye' | 'ear' | 'mouth' | 'spine';

export interface IOBoxInput {
  source: string;       // Where in Discord the data comes from
  format: string;       // wire format / file type
  quality: string;      // resolution / bitrate / sample rate
  notes?: string;
}

export interface IOBoxModel {
  name: string;
  size?: string;        // e.g. "8B Q4 / 12 GB VRAM"
  role: string;
}

export interface IOBoxTool {
  name: string;
  description: string;
  api?: string;         // discord.py / discord.js / discord-rs etc.
}

export interface IOBox {
  id: IOBoxId;
  kind: IOBoxKind;
  label: string;
  shortLabel: string;        // shown on hover label
  position: [number, number, number];
  size: [number, number, number];
  color: string;
  emissive: string;
  /** Sensory: how data flows IN. Motor (mouth/spine): how data flows OUT. */
  inputs?: IOBoxInput[];
  outputs?: IOBoxInput[];
  models?: IOBoxModel[];
  tools?: IOBoxTool[];
  pipesTo?: string[];        // brain region IDs this connects into
  pipesFrom?: string[];      // brain region IDs this receives from (motor)
  notes?: string[];
}

// Brain envelope is a 10×10×10 cube centered at origin (±5).
// I/O boxes sit just outside the cube faces.

export const IO_BOXES: IOBox[] = [
  // ─── Eyes (front face, +Z) ─────────────────────────────────────
  {
    id: 'eye_left',
    kind: 'eye',
    label: 'Left Eye',
    shortLabel: 'EYE L',
    position: [-1.7, 1.2, 6.6],
    size: [1.2, 1.2, 1.2],
    color: '#7be8ff',
    emissive: '#1a4060',
    inputs: [
      {
        source: 'Discord image attachments',
        format: 'PNG / JPEG / WebP',
        quality: 'Up to 25 MB / 4096 × 4096 px (Discord limit)',
        notes: 'Downloaded via attachment.proxy_url, resized to 1024px before VLM.',
      },
      {
        source: 'Inline image embeds',
        format: 'PNG / JPEG / GIF first frame',
        quality: 'Up to 4096 × 4096 px',
        notes: 'Embedded in messages via URL — fetched server-side.',
      },
      {
        source: 'User avatars + server icons',
        format: 'PNG / WebP',
        quality: '128 × 128 to 4096 × 4096 px',
        notes: 'Used for "who is this user" recall queries.',
      },
      {
        source: 'Animated GIF / APNG',
        format: 'First frame only',
        quality: 'Up to 50 MB animated',
        notes: 'Animation discarded — VLM sees one frame.',
      },
    ],
    models: [
      { name: 'Qwen3-VL-8B-Instruct', size: 'Q4_K_M · 12 GB VRAM', role: 'Multimodal vision-language model — image → caption + answer.' },
    ],
    pipesTo: ['visual', 'thalamus'],
    notes: [
      'LAZY-LOADED: only resident when an image arrives (~3s cold load).',
      'Swaps Whisper + Chatterbox off VRAM during inference.',
      'Discord CDN URLs expire — must download promptly or cache.',
    ],
  },
  {
    id: 'eye_right',
    kind: 'eye',
    label: 'Right Eye',
    shortLabel: 'EYE R',
    position: [1.7, 1.2, 6.6],
    size: [1.2, 1.2, 1.2],
    color: '#7be8ff',
    emissive: '#1a4060',
    inputs: [
      {
        source: 'Screen-share frames (voice channel)',
        format: 'H.264 → PNG keyframes',
        quality: '720p @ 30fps; sampled at 1 fps for VLM',
        notes: 'Captured from active stage / voice screen-share.',
      },
      {
        source: 'Camera-on video frames',
        format: 'H.264 → PNG keyframes',
        quality: '720p @ 30fps; sampled at 0.5 fps',
        notes: 'Only when user explicitly enables camera in voice.',
      },
      {
        source: 'Sticker + emoji renders',
        format: 'PNG / Lottie',
        quality: '320 × 320 px',
        notes: 'Treated as low-priority visual context.',
      },
    ],
    models: [
      { name: 'Qwen3-VL-8B-Instruct', size: 'shared with Left Eye', role: 'Same VLM instance — both eyes feed one model.' },
    ],
    pipesTo: ['visual', 'thalamus'],
    notes: [
      'Both eyes share the same VLM; the split is conceptual (static images vs. video frames).',
      'Frame-sampling rate auto-tunes based on insula VRAM pressure.',
    ],
  },

  // ─── Ears (lateral faces, ±X) ──────────────────────────────────
  {
    id: 'ear_left',
    kind: 'ear',
    label: 'Left Ear',
    shortLabel: 'EAR L',
    position: [-6.6, 0.5, 0],
    size: [1.2, 1.2, 1.2],
    color: '#ffd479',
    emissive: '#5a3a10',
    inputs: [
      {
        source: 'Discord voice channel — primary speaker',
        format: 'Opus 48 kHz stereo → PCM 16 kHz mono',
        quality: '64-128 kbps Opus → 256 kbps PCM',
        notes: 'Discord delivers Opus frames at 20 ms intervals; downmixed + resampled before Whisper.',
      },
      {
        source: 'Voice messages (DM / channel)',
        format: 'Opus → PCM',
        quality: '48 kHz Opus, transcribed in full',
        notes: 'Voice notes attached to messages.',
      },
      {
        source: 'Stage channel audio',
        format: 'Opus 48 kHz',
        quality: 'Same pipeline as voice channel',
      },
    ],
    models: [
      { name: 'Faster-Whisper Large-V3-Turbo', size: '~3 GB VRAM', role: 'Streaming ASR — partial transcripts every 200 ms.' },
      { name: 'Silero VAD', size: 'CPU, ~50 MB', role: 'Voice activity detection — gates Whisper.' },
      { name: 'Pipecat Smart-Turn', size: 'CPU', role: 'End-of-utterance detection (not silence-based).' },
    ],
    pipesTo: ['auditory', 'wernicke'],
    notes: [
      'Backchannel suppression: ignores "yeah", "uh-huh", "mhm" so the bot doesn\'t reply to filler.',
      'Per-speaker streams isolated via Discord SSRC tags — multi-speaker handled.',
    ],
  },
  {
    id: 'ear_right',
    kind: 'ear',
    label: 'Right Ear',
    shortLabel: 'EAR R',
    position: [6.6, 0.5, 0],
    size: [1.2, 1.2, 1.2],
    color: '#ffd479',
    emissive: '#5a3a10',
    inputs: [
      {
        source: 'Voice channel — secondary speakers',
        format: 'Opus → per-speaker PCM',
        quality: '48 kHz, mixed-down on demand',
        notes: 'Context-only — used to detect cross-talk and barge-in.',
      },
      {
        source: 'Background audio / music share',
        format: 'Opus 48 kHz',
        quality: '128 kbps; fed to acoustic classifier, NOT Whisper',
        notes: 'Music + ambient sound classified separately so Whisper isn\'t fed garbage.',
      },
      {
        source: 'Soundboard reactions',
        format: 'Opus short clips',
        quality: 'Detected as events, not transcribed',
      },
    ],
    models: [
      { name: 'Faster-Whisper Large-V3-Turbo', size: 'shared with Left Ear', role: 'Same ASR — both ears feed one transcription pipeline.' },
      { name: 'YAMNet (acoustic event detector)', size: '~17 MB', role: 'Music / laughter / silence classification.' },
    ],
    pipesTo: ['auditory'],
    notes: [
      'Both ears share one Whisper instance — the split is conceptual (primary speaker vs. ambient context).',
      'Audio pipeline degrades gracefully under VRAM pressure: drops to whisper-tiny if VLM is swapped in.',
    ],
  },

  // ─── Mouth (front-bottom, –Y +Z) ───────────────────────────────
  {
    id: 'mouth',
    kind: 'mouth',
    label: 'Mouth',
    shortLabel: 'MOUTH',
    position: [0, -3.2, 6.0],
    size: [2.0, 1.0, 1.4],
    color: '#ff7b9c',
    emissive: '#5a1828',
    outputs: [
      {
        source: 'Voice channel TTS stream',
        format: 'PCM 24 kHz mono → Opus 48 kHz',
        quality: '24 kHz studio-quality synthesis',
        notes: 'Streamed in 200 ms chunks for low-latency response.',
      },
      {
        source: 'Text replies (channel + DM)',
        format: 'UTF-8 Markdown',
        quality: 'Up to 2000 chars / message; chunked above',
        notes: 'Sent via discord.py channel.send / message.reply.',
      },
      {
        source: 'Embed responses',
        format: 'Discord Embed objects',
        quality: 'Title, fields, color, footer',
        notes: 'For structured replies (search results, status reports).',
      },
    ],
    models: [
      { name: 'Chatterbox', size: '~3 GB VRAM', role: 'Primary TTS — zero-shot voice clone from Cortana_voice.wav.' },
      { name: 'Kokoro-82M', size: '~300 MB CPU/GPU', role: 'Low-latency fallback when Chatterbox is swapped out.' },
    ],
    pipesFrom: ['motor_voice', 'broca', 'cerebellum'],
    notes: [
      'Cerebellum smooths streaming output — no abrupt cuts on barge-in.',
      'Backchannel suppression prevents talking over the user.',
      'Kokoro takes over within 50 ms if Chatterbox is mid-swap.',
    ],
  },

  // ─── Spine (below, –Y) ─ tools / motor outputs ─────────────────
  {
    id: 'spine',
    kind: 'spine',
    label: 'Spine — Tool Layer',
    shortLabel: 'SPINE',
    position: [0, -7.5, 0],
    size: [1.6, 4.0, 1.6],
    color: '#a07fff',
    emissive: '#2a1a5a',
    pipesFrom: ['sma', 'basal_ganglia', 'cerebellum_skill'],
    tools: [
      { name: 'send_message', description: 'Post a message in any channel Cortana has access to.', api: 'channel.send(content, embed?, file?)' },
      { name: 'reply', description: 'Reply to a specific message with reference link.', api: 'message.reply(content)' },
      { name: 'react', description: 'Add an emoji reaction to a message.', api: 'message.add_reaction(emoji)' },
      { name: 'edit_own_message', description: 'Edit a message Cortana previously sent.', api: 'message.edit(content)' },
      { name: 'delete_own_message', description: 'Delete one of Cortana\'s own messages.', api: 'message.delete()' },
      { name: 'search_history', description: 'Search the last N messages in a channel by keyword / user / date.', api: 'channel.history(limit, before, after)' },
      { name: 'fetch_user', description: 'Look up a user by ID, mention, or display name.', api: 'guild.get_member / fetch_user' },
      { name: 'join_voice', description: 'Join a voice channel to listen + speak.', api: 'voice_channel.connect()' },
      { name: 'leave_voice', description: 'Disconnect from voice channel.', api: 'voice_client.disconnect()' },
      { name: 'play_audio', description: 'Stream PCM/Opus into the joined voice channel.', api: 'voice_client.play(source)' },
      { name: 'create_thread', description: 'Spin off a thread from a message for sub-conversation.', api: 'message.create_thread(name)' },
      { name: 'pin_message', description: 'Pin a message to channel for later recall.', api: 'message.pin()' },
      { name: 'set_status', description: 'Change Cortana\'s presence (online / idle / dnd) + activity text.', api: 'client.change_presence(...)' },
      { name: 'upload_file', description: 'Attach a file to a message (logs, generated images, audio).', api: 'channel.send(file=discord.File(...))' },
      { name: 'create_invite', description: 'Generate a channel invite link with TTL + use limit.', api: 'channel.create_invite(...)' },
      { name: 'fetch_audit_log', description: 'Read recent moderation events on the server (admin only).', api: 'guild.audit_logs(limit)' },
      { name: 'webhook_post', description: 'Send a message under a custom name + avatar via webhook.', api: 'webhook.send(content, username, avatar_url)' },
    ],
    notes: [
      'Tool calls are executed by the spine — the brain decides WHAT, the spine decides HOW.',
      'Cerebellum smooths execution: retries with backoff on rate-limit, splits long messages.',
      'Skill library (cerebellum_skill) caches successful tool patterns for re-use.',
      'No write access outside the ASAP server — sandboxed by Discord token scope.',
    ],
  },
];

export const IO_BOX_BY_ID: Record<IOBoxId, IOBox> = IO_BOXES.reduce(
  (acc, b) => ((acc[b.id] = b), acc),
  {} as Record<IOBoxId, IOBox>,
);
