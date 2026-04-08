# ASAP Bot: Best Practices & Implementation Guide

**Last Updated:** 30 March 2026  
**Status:** Production Baseline Established

---

## Quick Reference

| Area | Status | Priority | Implementation |
|------|--------|----------|-----------------|
| Voice Chat | ✅ Production Ready | — | No changes needed |
| Error Handling | ✅ Good | LOW | Deploy as-is |
| Rate Limiting | ⚠️ Good | MEDIUM | Add exponential backoff (2-3h work) |
| Memory Cleanup | ⚠️ Good | MEDIUM | Idempotent connection cleanup (1h work) |
| TTS Fallback | ⚠️ Current | LOW | Add Gemini TTS fallback (1-2h work) |
| Monitoring | ✅ Diagnostics | LOW | Add Prometheus metrics (4-6h work) |

---

## Detailed Implementation Guide

### Priority 1: Exponential Backoff for Rate Limiting ⚡ (MEDIUM)

**Why:** Current fixed 60s retry on 429 doesn't handle cascading failures well.

**File:** [server/src/discord/claude.ts](server/src/discord/claude.ts)

**Current Code (~lines 180-200):**
```typescript
if (status === 429) {
  delay = 60_000; // Fixed 60 seconds
  rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + delay);
}
```

**Updated Code:**
```typescript
// Add at top of file
const BACKOFF_CONFIG = {
  baseDelay: 1000,        // 1 second
  maxDelay: 60000,        // 60 seconds
  factor: 2,              // Double each time
  maxRetries: 5,
};

function calculateBackoffDelay(retryCount: number): number {
  // Exponential: 1s, 2s, 4s, 8s, 16s + random jitter
  const exponential = Math.min(
    BACKOFF_CONFIG.baseDelay * Math.pow(BACKOFF_CONFIG.factor, retryCount),
    BACKOFF_CONFIG.maxDelay
  );
  const jitter = Math.random() * 1000; // ±1s randomness
  return exponential + jitter;
}

// In call handler
if (status === 429) {
  const delayMs = calculateBackoffDelay(retryAttempts);
  console.warn(`[RATE_LIMIT] Retrying in ${delayMs}ms (attempt ${retryAttempts + 1}/${BACKOFF_CONFIG.maxRetries})`);
  rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + delayMs);
  retryAttempts++;
  
  if (retryAttempts >= BACKOFF_CONFIG.maxRetries) {
    throw new Error(`Max retries exceeded (${BACKOFF_CONFIG.maxRetries})`);
  }
}
```

**Testing:**
```bash
# Simulate 429 by reducing DAILY_BUDGET_USD to $0.01
# Verify retry delays: 1s, 2s, 4s, 8s, 16s with ±1s jitter
# Confirm agent recovers after budget reset
```

**Impact:** Reduces cascading failures during API outages; smoother degradation

---

### Priority 2: Idempotent Connection Cleanup ⚡ (MEDIUM)

**Why:** Multiple `leaveVC()` calls or errors during disconnect can orphan connections.

**File:** [server/src/discord/voice/connection.ts](server/src/discord/voice/connection.ts)

**Current Code (~lines 50-80):**
```typescript
export function leaveVC(): void {
  if (audioPlayer) {
    audioPlayer.stop();
  }
  if (currentConnection) {
    currentConnection.destroy();
  }
}
```

**Updated Code:**
```typescript
// Add state tracking at module level
let isCleaningUp = false;

export function isVoiceActive(): boolean {
  return currentConnection !== null && !isCleaningUp;
}

export function leaveVC(): void {
  // Prevent double-cleanup
  if (isCleaningUp) {
    console.warn('[VOICE] Leave already in progress, skipping');
    return;
  }
  
  if (!currentConnection) {
    console.debug('[VOICE] No active connection to leave');
    return;
  }
  
  isCleaningUp = true;
  try {
    // Stop audio playback
    if (audioPlayer) {
      try {
        audioPlayer.stop();
      } catch (e) {
        console.warn('[VOICE] Error stopping audio player:', e.message);
      }
      audioPlayer = null;
    }
    
    // Destroy connection
    if (currentConnection) {
      try {
        currentConnection.destroy();
      } catch (e) {
        console.warn('[VOICE] Error destroying connection:', e.message);
      }
      currentConnection = null;
    }
    
    console.log('[VOICE] Successfully disconnected');
  } finally {
    isCleaningUp = false;
  }
}

// In error handlers
process.on('uncaughtException', () => {
  if (currentConnection) {
    leaveVC(); // Ensures cleanup even on crash
  }
});
```

**Testing:**
```bash
# Test 1: Normal disconnect → reconnect (should work)
# Test 2: Double disconnect (should warn, not error)
# Test 3: Disconnect during playback (should cleanly stop)
# Test 4: Memory check: `node --inspect` → DevTools → Heap snapshot
#         Verify connection object released after disconnect
```

**Impact:** Prevents memory leaks from orphaned connections; safer error recovery

---

### Priority 3: Graceful TTS Fallback ✓ (LOW)

**Why:** If ElevenLabs fails mid-call, audio should still play via Gemini.

**File:** [server/src/discord/voice/tts.ts](server/src/discord/voice/tts.ts)

**Current Code (~lines 40-60):**
```typescript
export async function textToSpeech(text: string, voiceName: string): Promise<Buffer> {
  if (isElevenLabsAvailable()) {
    return elevenLabsTTS(text, voiceName); // Throws if ElevenLabs fails
  }
  return geminiTTS(text, voiceName);
}
```

**Updated Code:**
```typescript
export async function textToSpeech(
  text: string,
  voiceName: string,
  forceGemini: boolean = false
): Promise<{ buffer: Buffer; source: 'elevenlabs' | 'gemini' }> {
  const context = { text: text.substring(0, 50) + '...', voiceName };
  
  // Try ElevenLabs first (unless explicitly forced to Gemini)
  if (!forceGemini && isElevenLabsAvailable()) {
    try {
      console.debug('[TTS] Attempting ElevenLabs...', context);
      const buffer = await elevenLabsTTS(text, voiceName);
      console.log('[TTS] ElevenLabs success');
      return { buffer, source: 'elevenlabs' };
    } catch (err) {
      console.warn('[TTS] ElevenLabs failed, falling back to Gemini:', err.message);
      // Fall through to Gemini
    }
  }
  
  // Try Gemini
  if (!isGeminiAvailable()) {
    throw new Error('[TTS] No TTS service available (ElevenLabs + Gemini both down)');
  }
  
  try {
    console.debug('[TTS] Attempting Gemini...', context);
    const buffer = await geminiTTS(text, voiceName);
    console.log('[TTS] Gemini success (fallback)');
    return { buffer, source: 'gemini' };
  } catch (err) {
    throw new Error(`[TTS] Gemini failed: ${err.message}`);
  }
}

// Update call sites
export async function speakPipelined(messages: string[], voiceName: string): Promise<void> {
  for (const message of messages) {
    try {
      const { buffer, source } = await textToSpeech(message, voiceName);
      console.log(`[TTS] Speaking: ${source}`);
      await playAudio(buffer);
    } catch (err) {
      console.error('[SPEAK] TTS failed for message:', err.message);
      // Continue with next message instead of stopping call
    }
  }
}
```

**Testing:**
```bash
# Test 1: Normal operation (ElevenLabs works) → verify 'elevenlabs' source in logs
# Test 2: Mock ElevenLabs 500 error → verify fallback to Gemini
# Test 3: Mock both failed → verify graceful error + call continues
# Test 4: Cost comparison: ElevenLabs vs Gemini for equivalent calls
```

**Impact:** Keeps voice calls working even if primary TTS fails; user unaware of switch

---

### Priority 4: Prometheus Monitoring Setup ✓ (LOW)

**Why:** Need observability for production health monitoring.

**New File:** [server/src/discord/metrics.ts](server/src/discord/metrics.ts)

```typescript
import { Counter, Histogram, Gauge } from 'prom-client';

// Counters (cumulative)
export const voiceCallsTotal = new Counter({
  name: 'asap_voice_calls_total',
  help: 'Total voice calls initiated',
  labelNames: ['initiator', 'status'], // status: success, failed
});

export const apiCallsTotal = new Counter({
  name: 'asap_api_calls_total',
  help: 'Total API calls',
  labelNames: ['service', 'method', 'status_code'],
});

export const ttsErrorsTotal = new Counter({
  name: 'asap_tts_errors_total',
  help: 'Total TTS failures',
  labelNames: ['service', 'error_type'], // service: elevenlabs, gemini
});

// Gauges (point-in-time)
export const voiceCallsActive = new Gauge({
  name: 'asap_voice_calls_active',
  help: 'Number of active voice calls',
});

export const geminiSpentToday = new Gauge({
  name: 'asap_gemini_spent_usd',
  help: 'USD spent on Gemini today',
});

export const memoryUsageMb = new Gauge({
  name: 'asap_memory_usage_mb',
  help: 'Process memory usage in MB',
});

// Histograms (latency/distribution)
export const ttsLatencyMs = new Histogram({
  name: 'asap_tts_latency_ms',
  help: 'TTS generation latency in milliseconds',
  labelNames: ['service'], // service: elevenlabs, gemini
  buckets: [50, 100, 200, 500, 1000, 2000, 5000],
});

export const transcriptionLatencyMs = new Histogram({
  name: 'asap_transcription_latency_ms',
  help: 'Transcription latency',
  labelNames: ['service'], // service: deepgram, gemini
  buckets: [500, 1000, 1500, 2000, 3000, 5000],
});

export const agentResponseTimeMs = new Histogram({
  name: 'asap_agent_response_time_ms',
  help: 'Agent response time',
  labelNames: ['agent', 'tool_count'],
  buckets: [500, 1000, 2000, 5000, 10000],
});

// Usage tracking functions
export function recordVoiceCall(status: 'success' | 'failed', initiator: string): void {
  voiceCallsTotal.inc({ status, initiator });
}

export function recordTtsUsage(service: 'elevenlabs' | 'gemini', latency: number): void {
  ttsLatencyMs.observe({ service }, latency);
}

export function recordApiCall(service: string, method: string, statusCode: number): void {
  apiCallsTotal.inc({ service, method, status_code: statusCode.toString() });
}

export function recordMemory(): void {
  const usage = process.memoryUsage();
  memoryUsageMb.set(usage.heapUsed / 1024 / 1024);
}
```

**Integration in [server/src/discord/handlers/callSession.ts](server/src/discord/handlers/callSession.ts):**
```typescript
import * as metrics from '../metrics.js';

export async function startCall(...): Promise<void> {
  const startTime = Date.now();
  metrics.voiceCallsActive.inc();
  
  try {
    // ... existing code
  } finally {
    const duration = Date.now() - startTime;
    metrics.voiceCallsActive.dec();
    metrics.recordVoiceCall('success', 'riley');
  }
}
```

**Expose metrics endpoint in [server/src/index.ts](server/src/index.ts):**
```typescript
import { register } from 'prom-client';

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});
```

**Grafana Dashboard Queries:**
```
# Active voice calls
asap_voice_calls_active

# TTS latency p95
histogram_quantile(0.95, asap_tts_latency_ms)

# Daily Gemini spend
asap_gemini_spent_usd

# Agent response time p99
histogram_quantile(0.99, asap_agent_response_time_ms)

# API error rate by service
rate(asap_api_calls_total{status_code=~"5.."}[5m])
```

**Testing:**
```bash
# Start bot with metrics export enabled
# Test: curl http://localhost:3000/metrics
# Verify: Prometheus scrapes metrics successfully
# Build Grafana dashboard (templates available in Grafana docs)
```

**Impact:** Enables proactive health monitoring; facilitates debugging; supports SLA tracking

---

## Deployment Workflow

### Step 1: Code Changes
Pick one priority from above. Make changes in a feature branch.

```bash
git checkout -b fix/rate-limit-backoff
# ... make changes ...
git add server/src/discord/claude.ts
git commit -m "feat: exponential backoff for rate limited API calls"
```

### Step 2: Local Testing
```bash
npm run build        # Verify TypeScript compiles
npm run test         # Run unit tests (if applicable)
npm start            # Start bot locally
```

### Step 3: Staging Deployment
Push to bot VM for testing in controlled environment:
```bash
git push origin fix/rate-limit-backoff
gcloud compute ssh asap-bot-vm -- \
  "cd /home/asap/bot && git pull origin fix/rate-limit-backoff && npm run build && pm2 restart bot"
```

### Step 4: Production Rollout
After 2-3 hours of stable staging:
```bash
git push origin main
git tag v1.2.3 -m "Added exponential backoff + fixes"
# Deploy via CI/CD or manual: git pull + npm run build + pm2 restart
```

---

## Monitoring After Deployment

### Immediate (First 2 hours):
```bash
# Watch bot logs
gcloud compute ssh asap-bot-vm -- "pm2 logs bot"

# Check memory usage
gcloud compute ssh asap-bot-vm -- "pm2 monit"

# Verify error webhook (in #diagnostics)
```

### Ongoing (Daily):
```bash
# Monitor metrics dashboard
# Alert if: Gemini spend > $10/day, error rate > 1%, memory > 500MB
# Weekly review of latency p95 trends
```

---

## Rollback Plan

If a deployment causes issues:

```bash
# Identify bad commit
# git log --oneline (find the problematic commit hash)

# Rollback to previous stable
git revert <bad-commit-hash>
git push origin main

# Or immediate rollback
gcloud compute ssh asap-bot-vm -- \
  "cd /home/asap/bot && git reset --hard HEAD~1 && npm run build && pm2 restart bot"
```

---

## Summary

| Task | Effort | Impact | Status |
|------|--------|--------|--------|
| Exponential Backoff | 2-3h | High (reliability) | Ready for implementation |
| Idempotent Cleanup | 1-2h | Medium (memory) | Ready for implementation |
| TTS Fallback | 1-2h | Medium (resilience) | Ready for implementation |
| Prometheus Metrics | 4-6h | Medium (observability) | Framework provided |
| **TOTAL PIPELINE** | **8-13h** | **High overall** | **Suggest: 2-week sprint** |

**Recommendation:** Prioritize exponential backoff (highest reliability impact). Schedule one improvement per sprint over 2-3 weeks.

---

**Questions? Contact:** @jordan (via Discord)  
**Last Updated:** 30 March 2026 | v1.0
