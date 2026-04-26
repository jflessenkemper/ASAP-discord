/**
 * Typed, grouped runtime config readers for the env vars that appear in
 * multiple files. Centralizing them keeps the defaults in one place and
 * gives discoverability without churning every call site.
 *
 * Scope: Cortana orchestration + voice call tuning, since those are the
 * env groups with cross-file readers. Single-file env knobs stay inline
 * at the call site — moving them here would be pure indirection.
 *
 * Every getter resolves lazily so tests can override `process.env` between
 * test cases without re-importing.
 */

import { envBoolFirst, envFirst, envIntFirst } from '../utils/env';

/** Cortana (executive-assistant) orchestration knobs. */
export const cortanaConfig = {
  stallNoticeCooldownMs: () =>
    envIntFirst(['CORTANA_STALL_NOTICE_COOLDOWN_MS', 'CORTANA_STALL_NOTICE_COOLDOWN_MS'], 120_000),
  noResponseTimeoutMs: () =>
    envIntFirst(['CORTANA_NO_RESPONSE_TIMEOUT_MS', 'CORTANA_NO_RESPONSE_TIMEOUT_MS'], 180_000),
  progressPingMs: (noResponseTimeoutMs: number) =>
    envIntFirst(
      ['CORTANA_PROGRESS_PING_MS', 'CORTANA_PROGRESS_PING_MS'],
      Math.max(20_000, Math.floor(noResponseTimeoutMs * 0.6)),
    ),
  tokenOverrunAllowance: () =>
    envIntFirst(['CORTANA_TOKEN_OVERRUN_ALLOWANCE', 'CORTANA_TOKEN_OVERRUN_ALLOWANCE'], 2_000_000),
  maxContinuationCycles: () =>
    envIntFirst(['CORTANA_MAX_CONTINUATION_CYCLES', 'CORTANA_MAX_CONTINUATION_CYCLES'], 3),
  allowImplicitInfraActions: () =>
    envBoolFirst(['CORTANA_ALLOW_IMPLICIT_INFRA_ACTIONS', 'CORTANA_ALLOW_IMPLICIT_INFRA_ACTIONS']),
  autoApproveBudgetIncrementUsd: () => {
    const raw = envFirst(['CORTANA_AUTO_APPROVE_BUDGET_INCREMENT_USD', 'CORTANA_AUTO_APPROVE_BUDGET_INCREMENT_USD'], '5');
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : 5;
  },
  autoApproveBudgetMaxPasses: () =>
    envIntFirst(['CORTANA_AUTO_APPROVE_BUDGET_MAX_PASSES', 'CORTANA_AUTO_APPROVE_BUDGET_MAX_PASSES'], 4),
};

/** ElevenLabs/telephony voice naming. */
export const voiceConfig = {
  telephonyVoiceName: () =>
    envFirst(['TELEPHONY_CORTANA_VOICE_NAME', 'TELEPHONY_CORTANA_VOICE_NAME'], 'CortanaEL'),
  cortanaMaxTokens: (lowLatency: boolean) =>
    envIntFirst(
      ['VOICE_MAX_TOKENS_CORTANA', 'VOICE_MAX_TOKENS_CORTANA'],
      lowLatency ? 120 : 220,
    ),
};
