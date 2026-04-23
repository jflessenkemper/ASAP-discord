#!/usr/bin/env node
/**
 * Read a whisper transcript and produce a voice-style card that can be dropped
 * into the ElevenLabs Conversational AI agent system prompt so the underlying
 * LLM mimics the speaker's phrasing, cadence, and topic preferences.
 *
 * Usage:
 *   node scripts/extract-voice-style.mjs <transcript-file>
 *
 * The script hits the local Anthropic/Vertex endpoint the bot already uses
 * (reads ANTHROPIC_API_KEY or falls back to `gcloud` ADC via VERTEX). It
 * prints the style card to stdout — pipe it into the ElevenLabs Convai prompt.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const [, , transcriptPath] = process.argv;
if (!transcriptPath) {
  console.error('usage: node scripts/extract-voice-style.mjs <transcript-file>');
  process.exit(1);
}

const transcript = await fs.readFile(path.resolve(transcriptPath), 'utf8');

const SYSTEM = `You extract voice style cards from transcripts. Given a transcript, produce a concise style guide an LLM can follow to speak like the person in the transcript.

Return Markdown with these sections, each 1–3 bullets, nothing else:

## Voice style
## Cadence and filler words
## Vocabulary and phrases
## Topic preferences and opinions
## What to avoid

Be specific. Quote actual phrases the speaker used. If a preference is strongly expressed, include it. If the speaker has opinions or recurring themes, record them verbatim as "often says/believes".`;

const USER = `Transcript:\n\n${transcript.slice(0, 60_000)}\n\nProduce the style card.`;

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY not set. Set it, or adapt this script to call Vertex if you prefer that path.');
  process.exit(1);
}

const res = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  },
  body: JSON.stringify({
    model: process.env.STYLE_EXTRACT_MODEL || 'claude-sonnet-4-6',
    max_tokens: 1200,
    system: SYSTEM,
    messages: [{ role: 'user', content: USER }],
  }),
});

if (!res.ok) {
  const err = await res.text();
  console.error(`Anthropic HTTP ${res.status}: ${err}`);
  process.exit(1);
}

const data = await res.json();
const text = (data.content ?? []).map((b) => b.text ?? '').join('').trim();
process.stdout.write(text + '\n');
