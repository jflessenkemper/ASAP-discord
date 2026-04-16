/**
 * Canonical Discord integration surface for the server runtime.
 *
 * Keep orchestration imports pointed at this file so future refactors can
 * move internals without touching the HTTP/runtime entrypoints.
 */

// Lifecycle + channel access
export { startBot, stopBot, getBotChannels } from './bot';

// External webhook bridge
export { verifySignature, handleGitHubEvent } from './handlers/github';

// Operations helpers
export { captureAndPostScreenshots } from './services/screenshots';
export { postAgentErrorLog } from './services/agentErrors';

// Telephony bridge
export { getInboundTwiML, attachTelephonyWebSocket, isTelephonyAvailable } from './services/telephony';

// Metrics + budget
export { getMetricsText, PROMETHEUS_CONTENT_TYPE, updateLlmSpend, updateGeminiSpend } from './metrics';
export { getRemainingBudget } from './usage';
