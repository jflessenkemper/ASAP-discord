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

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
