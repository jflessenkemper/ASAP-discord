interface DiagnosticExtra {
  source?: string;
  detail?: string;
  level?: 'info' | 'warn' | 'error';
}

/** Post operational diagnostics to an external Discord webhook, if configured. */
export async function postDiagnostic(message: string, extra?: DiagnosticExtra): Promise<void> {
  const url = process.env.DISCORD_DIAGNOSTIC_WEBHOOK_URL;
  if (!url) return;

  const level = extra?.level || 'info';
  const levelIcon = level === 'error' ? '🚨' : level === 'warn' ? '⚠️' : 'ℹ️';
  const source = extra?.source ? `\nSource: ${extra.source}` : '';
  const detail = extra?.detail ? `\nDetail: ${truncate(extra.detail, 1200)}` : '';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'ASAP Diagnostics',
        content: `${levelIcon} ${message}${source}${detail}`,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`Diagnostic webhook failed: ${res.status} ${truncate(body, 200)}`);
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
  const preview = truncate(response.replace(/\s+/g, ' ').trim(), 1500);
  await postDiagnostic(`Agent response mirrored`, {
    level: 'info',
    source: `agent:${agentDisplayName}`,
    detail: `channel=${channelName}\nresponse=${preview}`,
  });
}

/** Mirror user voice transcript events for end-to-end call debugging. */
export async function mirrorVoiceTranscript(
  username: string,
  text: string,
  language?: string
): Promise<void> {
  const lang = language ? ` language=${language}` : '';
  await postDiagnostic(`Voice transcript mirrored`, {
    level: 'info',
    source: 'voice:transcript',
    detail: `user=${username}${lang}\ntext=${truncate(text, 1200)}`,
  });
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
