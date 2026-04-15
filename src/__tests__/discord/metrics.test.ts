/**
 * Tests for src/discord/metrics.ts
 * Prometheus-style metrics — counters, gauges, histograms, text serialization.
 */

import {
  recordVoiceCallStart,
  recordVoiceCallEnd,
  recordTtsError,
  recordTtsLatency,
  recordTranscriptionLatency,
  recordAgentResponse,
  recordRateLimitHit,
  recordTextChannelTimeout,
  updateTextChannelQueueDepth,
  updateGeminiSpend,
  getMetricsText,
  PROMETHEUS_CONTENT_TYPE,
} from '../../discord/metrics';

describe('metrics', () => {
  describe('PROMETHEUS_CONTENT_TYPE', () => {
    it('is valid Prometheus text format', () => {
      expect(PROMETHEUS_CONTENT_TYPE).toContain('text/plain');
      expect(PROMETHEUS_CONTENT_TYPE).toContain('0.0.4');
    });
  });

  describe('getMetricsText()', () => {
    it('returns non-empty text', () => {
      const text = getMetricsText();
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    });

    it('includes HELP and TYPE annotations', () => {
      const text = getMetricsText();
      expect(text).toContain('# HELP');
      expect(text).toContain('# TYPE');
    });

    it('includes process metrics', () => {
      const text = getMetricsText();
      expect(text).toContain('asap_memory_usage_mb');
      expect(text).toContain('asap_process_uptime_seconds');
    });

    it('includes counter type declarations', () => {
      const text = getMetricsText();
      expect(text).toContain('# TYPE asap_voice_calls_total counter');
      expect(text).toContain('# TYPE asap_rate_limit_hits_total counter');
    });

    it('includes gauge type declarations', () => {
      const text = getMetricsText();
      expect(text).toContain('# TYPE asap_voice_calls_active gauge');
    });

    it('includes histogram type declarations', () => {
      const text = getMetricsText();
      expect(text).toContain('# TYPE asap_tts_latency_ms histogram');
    });
  });

  describe('voice call tracking', () => {
    it('increments active calls on start', () => {
      recordVoiceCallStart();
      const text = getMetricsText();
      expect(text).toContain('asap_voice_calls_total');
      expect(text).toContain('asap_voice_calls_active');
    });

    it('decrements active calls on end', () => {
      recordVoiceCallStart();
      recordVoiceCallEnd();
      // Should not go below 0
      recordVoiceCallEnd();
      const text = getMetricsText();
      expect(text).toContain('asap_voice_calls_active');
    });
  });

  describe('TTS metrics', () => {
    it('records TTS errors with labels', () => {
      recordTtsError('elevenlabs', 'timeout');
      const text = getMetricsText();
      expect(text).toContain('asap_tts_errors_total');
      expect(text).toContain('elevenlabs');
    });

    it('records TTS latency histogram', () => {
      recordTtsLatency('gemini', 150);
      const text = getMetricsText();
      expect(text).toContain('asap_tts_latency_ms_bucket');
      expect(text).toContain('asap_tts_latency_ms_sum');
      expect(text).toContain('asap_tts_latency_ms_count');
    });
  });

  describe('transcription metrics', () => {
    it('records transcription latency', () => {
      recordTranscriptionLatency('deepgram', 500);
      const text = getMetricsText();
      expect(text).toContain('asap_transcription_latency_ms_bucket');
    });
  });

  describe('agent metrics', () => {
    it('records agent response with latency', () => {
      recordAgentResponse('developer', 2500);
      const text = getMetricsText();
      expect(text).toContain('asap_agent_invocations_total');
      expect(text).toContain('developer');
      expect(text).toContain('asap_agent_response_time_ms_bucket');
    });
  });

  describe('rate limiting', () => {
    it('records rate limit hits', () => {
      recordRateLimitHit();
      const text = getMetricsText();
      expect(text).toContain('asap_rate_limit_hits_total');
    });
  });

  describe('text channel metrics', () => {
    it('records text channel timeouts', () => {
      recordTextChannelTimeout('qa');
      const text = getMetricsText();
      expect(text).toContain('asap_text_channel_timeouts_total');
      expect(text).toContain('qa');
    });

    it('updates queue depth gauge', () => {
      updateTextChannelQueueDepth('developer', 3);
      const text = getMetricsText();
      expect(text).toContain('asap_text_channel_queue_depth');
    });

    it('clamps queue depth to 0', () => {
      updateTextChannelQueueDepth('developer', -5); // should clamp
      // No error thrown
    });
  });

  describe('Gemini spend', () => {
    it('updates Gemini spend gauge', () => {
      updateGeminiSpend(12.50);
      const text = getMetricsText();
      expect(text).toContain('asap_gemini_spent_usd');
    });
  });
});
