interface DiagnosticExtra {
  source?: string;
  detail?: string;
  level?: 'info' | 'warn' | 'error';
}

const MAX_DISCORD_CONTENT = 1900;

function diagnosticsVerbose(): boolean {
  return String(process.env.DIAGNOSTIC_WEBHOOK_VERBOSE || '').toLowerCase() === 'true';
}

/** Post operational diagnostics to an external Discord webhook, if configured. */
export async function postDiagnostic(message: string, extra?: DiagnosticExtra): Promise<void> {
  const url = process.env.DISCORD_DIAGNOSTIC_WEBHOOK_URL;
  if (!url) return;

  const level = extra?.level || 'info';
  const levelIcon = level === 'error' ? '🚨' : level === 'warn' ? '⚠️' : 'ℹ️';
  const source = extra?.source ? `\nSource: ${extra.source}` : '';
  const detailText = extra?.detail || '';
  const detail = detailText
    ? `\nDetail: ${diagnosticsVerbose() ? detailText : truncate(detailText, 1200)}`
    : '';
  const content = `${levelIcon} ${message}${source}${detail}`;

  try {
    for (const chunk of splitMessage(content, MAX_DISCORD_CONTENT)) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'ASAP Diagnostics',
          content: chunk,
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.warn(`Diagnostic webhook failed: ${res.status} ${truncate(body, 200)}`);
      }
    }
  } catch (err) {
    console.warn('Diagnostic webhook error:', err instanceof Error ? err.message : 'Unknown');
  }
}

/** Mirror agent responses so operators can observe behavior without opening Discord channels. */
export async function mirrorAgentResponse(
  agentDisplayName: string,
  channelName: string,
  response: string
): Promise<void> {
  const normalized = response.replace(/\s+/g, ' ').trim();
  const body = diagnosticsVerbose() ? normalized : truncate(normalized, 1500);
  await postDiagnostic(`Agent response mirrored`, {
    level: 'info',
    source: `agent:${agentDisplayName}`,
    detail: `channel=${channelName}\nresponse=${body}`,
  });
}

/** Mirror user voice transcript events for end-to-end call debugging. */
export async function mirrorVoiceTranscript(
  username: string,
  text: string,
  language?: string
): Promise<void> {
  const lang = language ? ` language=${language}` : '';
  const mirroredText = diagnosticsVerbose() ? text : truncate(text, 1200);
  await postDiagnostic(`Voice transcript mirrored`, {
    level: 'info',
    source: 'voice:transcript',
    detail: `user=${username}${lang}\ntext=${mirroredText}`,
  });
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + maxLen));
    start += maxLen;
  }
  return chunks;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
