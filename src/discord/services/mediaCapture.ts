/**
 * Capture user-uploaded images and other attachments into user_events.
 *
 * Images get a Gemini Flash vision caption (which also extracts any visible
 * text — the Gemini response serves as our OCR). The caption becomes the
 * searchable `text` field so Cortana can recall "the screenshot I sent yesterday
 * about the bug" via semantic search.
 *
 * Non-image attachments (audio, video, documents) are recorded with filename +
 * URL only — the embedding worker will pick them up if Cortana ever enriches
 * their text later.
 */

import { GoogleAuth } from 'google-auth-library';
import { Message } from 'discord.js';

import { ensureGoogleCredentials } from '../../services/googleCredentials';
import { VERTEX_PROJECT_ID, VERTEX_LOCATION } from '../../services/modelConfig';
import { recordUserEvent, writeEmbedding } from '../userEvents';
import { embedText } from '../embeddings';
import { errMsg } from '../../utils/errors';

const VISION_MODEL = process.env.VISION_MODEL || 'gemini-2.0-flash';
const VISION_MAX_BYTES = 4 * 1024 * 1024; // 4 MB cap — larger images are skipped.

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

async function getAccessToken(): Promise<string | null> {
  await ensureGoogleCredentials(VERTEX_PROJECT_ID).catch(() => false);
  try {
    const client = await auth.getClient();
    const tokenResult = await client.getAccessToken();
    return typeof tokenResult === 'string' ? tokenResult : tokenResult?.token ?? null;
  } catch (err) {
    console.error('[mediaCapture] access token failed:', errMsg(err));
    return null;
  }
}

function isImageContentType(contentType: string | null | undefined): boolean {
  return !!contentType && contentType.toLowerCase().startsWith('image/');
}

async function fetchAsBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
    if (contentLength > VISION_MAX_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > VISION_MAX_BYTES) return null;
    const mimeType = res.headers.get('content-type') || 'image/jpeg';
    return { data: buf.toString('base64'), mimeType };
  } catch (err) {
    console.warn('[mediaCapture] fetch failed:', errMsg(err));
    return null;
  }
}

async function describeImage(url: string): Promise<string | null> {
  if (!VERTEX_PROJECT_ID) return null;
  const token = await getAccessToken();
  if (!token) return null;

  const image = await fetchAsBase64(url);
  if (!image) return null;

  const location = VERTEX_LOCATION || 'us-central1';
  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${location}/publishers/google/models/${encodeURIComponent(VISION_MODEL)}:generateContent`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: 'Describe this image in 2-3 sentences, then list any visible text verbatim under a "Text:" heading. Be concise.',
          },
          { inlineData: { mimeType: image.mimeType, data: image.data } },
        ],
      },
    ],
    generationConfig: { maxOutputTokens: 400, temperature: 0.2 },
  };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.warn(`[mediaCapture] vision HTTP ${res.status}: ${errBody.slice(0, 200)}`);
      return null;
    }
    const data = await res.json() as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? '').join('').trim();
    return text || null;
  } catch (err) {
    console.warn('[mediaCapture] describeImage failed:', errMsg(err));
    return null;
  }
}

interface CaptureContext {
  parentChannelId: string;
  threadId: string | null;
}

export async function captureAttachments(message: Message, ctx: CaptureContext): Promise<void> {
  const attachments = Array.from(message.attachments.values());
  for (const att of attachments) {
    const isImage = isImageContentType(att.contentType);
    const kind = isImage ? 'image' : (att.contentType?.startsWith('audio/') ? 'voice' : 'image');
    const initialText = `[${isImage ? 'Image' : 'Attachment'}: ${att.name || 'file'}]`;

    const eventId = await recordUserEvent({
      userId: message.author.id,
      channelId: ctx.parentChannelId,
      threadId: ctx.threadId,
      messageId: message.id,
      kind: isImage ? 'image' : kind,
      text: initialText,
      attachmentRef: att.url,
      metadata: {
        filename: att.name,
        contentType: att.contentType,
        size: att.size,
        proxyUrl: att.proxyURL,
      },
    });

    if (!isImage || !eventId) continue;

    // Enrich the row with a vision caption in the background.
    void (async () => {
      const caption = await describeImage(att.url);
      if (!caption) return;
      const enriched = `${initialText}\n${caption}`;
      try {
        const pool = (await import('../../db/pool')).default;
        await pool.query('UPDATE user_events SET text = $2 WHERE id = $1', [eventId, enriched]);
      } catch (err) {
        console.warn('[mediaCapture] caption persist failed:', errMsg(err));
        return;
      }
      // Embed immediately so recall works on the enriched text.
      const vec = await embedText(enriched);
      if (vec) await writeEmbedding(eventId, vec);
    })().catch((err) => console.warn('[mediaCapture] enrich failed:', errMsg(err)));
  }
}
