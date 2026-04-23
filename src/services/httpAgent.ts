/**
 * Global HTTP keep-alive agent for outbound `fetch` calls to LLM/TTS APIs.
 *
 * Node 22's default undici Agent uses short keep-alive timeouts (~4s), which
 * for sparsely-spaced LLM traffic (30s+ between turns) means every call pays
 * TCP handshake + TLS negotiation + HTTP/2 setup — often 150–300ms of overhead
 * before the first byte.
 *
 * Installing a longer-keepalive agent globally lets sequential calls to the
 * same origin reuse the connection. Typical TTFT improvement:
 *   • Anthropic / Vertex / ElevenLabs: ~100–250 ms per call
 *   • Compounds when a turn does 2–4 calls (planner → tools → synthesis)
 *
 * Safe to install at process start; undici exports a simple setter and this
 * matches what major Node HTTP clients (Ky, Got, Axios with agent) do.
 */

import { Agent, setGlobalDispatcher } from 'undici';

const KEEP_ALIVE_MS = Math.max(30_000, parseInt(process.env.HTTP_KEEPALIVE_MS || '120000', 10));
const CONNECTIONS_PER_ORIGIN = Math.max(4, parseInt(process.env.HTTP_CONNECTIONS_PER_ORIGIN || '16', 10));
const HEADERS_TIMEOUT_MS = Math.max(5_000, parseInt(process.env.HTTP_HEADERS_TIMEOUT_MS || '45000', 10));
const BODY_TIMEOUT_MS = Math.max(5_000, parseInt(process.env.HTTP_BODY_TIMEOUT_MS || '300000', 10));

let installed = false;

/**
 * Install the global dispatcher. Idempotent — safe to call multiple times.
 */
export function installGlobalHttpAgent(): void {
  if (installed) return;
  installed = true;

  const agent = new Agent({
    keepAliveTimeout: KEEP_ALIVE_MS,
    keepAliveMaxTimeout: KEEP_ALIVE_MS * 2,
    connections: CONNECTIONS_PER_ORIGIN,
    pipelining: 1, // fetch doesn't benefit from pipelining; stick to sequential
    headersTimeout: HEADERS_TIMEOUT_MS,
    bodyTimeout: BODY_TIMEOUT_MS,
  });

  setGlobalDispatcher(agent);

  console.log(
    `[httpAgent] global keep-alive installed ` +
    `(keepAlive=${KEEP_ALIVE_MS}ms, conns/origin=${CONNECTIONS_PER_ORIGIN})`,
  );
}
