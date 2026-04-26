/**
 * Tests for src/discord/turnTracker.ts
 *
 * The tracker renders a single, edit-in-place Discord message that reflects
 * Cortana's live turn + any sub-agents she consults. Asserts on the actual
 * rendered body by capturing calls to the webhook send/edit helpers.
 */

const mockSendWebhookMessage = jest.fn();
const mockEditWebhookMessage = jest.fn();

jest.mock('../../discord/services/webhooks', () => ({
  sendWebhookMessage: (...args: unknown[]) => mockSendWebhookMessage(...args),
  editWebhookMessage: (...args: unknown[]) => mockEditWebhookMessage(...args),
}));

import { beginTurn } from '../../discord/turnTracker';

const channel = { id: 'chan_123' } as unknown as Parameters<typeof beginTurn>[0];

function makeAgent(overrides: Partial<{ id: string; name: string; roleName: string; emoji: string; avatarUrl: string }> = {}) {
  return {
    id: 'executive-assistant',
    name: 'Cortana (Executive Assistant)',
    roleName: 'Cortana',
    emoji: '📋',
    avatarUrl: 'https://avatars/cortana.png',
    ...overrides,
  } as unknown as Parameters<typeof beginTurn>[1];
}

const argus = makeAgent({ id: 'qa', name: 'Argus (QA)', roleName: 'Argus', emoji: '🧪' });
const aphrodite = makeAgent({ id: 'ux-reviewer', name: 'Aphrodite (UX Reviewer)', roleName: 'Aphrodite', emoji: '🎨' });

beforeEach(() => {
  jest.clearAllMocks();
  // Each test starts with a fake message returned from sendWebhookMessage so
  // the tracker has an id to edit.
  mockSendWebhookMessage.mockResolvedValue({ id: 'msg_abc', channelId: 'chan_123' });
  mockEditWebhookMessage.mockResolvedValue({ id: 'msg_abc', channelId: 'chan_123' });
});

/**
 * Let the debounced render + any triggered async work actually run. The
 * tracker uses a setTimeout(…, ~400ms) internally then awaits a webhook
 * mock — using a real wait keeps the test close to production behavior.
 */
async function flushAndGetLastBody(waitMs = 550): Promise<string> {
  await new Promise((r) => setTimeout(r, waitMs));
  // Prefer the most recent edit (tracker edits in place after the initial send).
  if (mockEditWebhookMessage.mock.calls.length > 0) {
    const last = mockEditWebhookMessage.mock.calls.at(-1) as unknown[];
    return last[2] as string;
  }
  const last = mockSendWebhookMessage.mock.calls.at(-1) as unknown[];
  return ((last[1] as { content: string }).content);
}

describe('turnTracker', () => {
  describe('initial state', () => {
    it('sends a "thinking…" placeholder when Cortana has no section yet', async () => {
      const cortana = makeAgent();
      await beginTurn(channel, cortana);
      const body = await flushAndGetLastBody();
      // Owner header is now name-less ("Thinking…" + subtext label) — the
      // webhook avatar identifies Cortana, so duplicating her name in the
      // body would be redundant.
      expect(body).toMatch(/^\*\*Thinking…\*\*/);
      expect(body).toContain('thinking');
    });

    it('uses the webhook agent identity on the initial send', async () => {
      const cortana = makeAgent();
      await beginTurn(channel, cortana);
      await new Promise((r) => setTimeout(r, 550));
      expect(mockSendWebhookMessage).toHaveBeenCalled();
      const opts = (mockSendWebhookMessage.mock.calls[0] as unknown[])[1] as { username: string; avatarURL: string };
      expect(opts.username).toBe('Cortana'); // short role name, not "Cortana (Executive Assistant)"
      expect(opts.avatarURL).toBe('https://avatars/cortana.png');
    });
  });

  describe('render with sub-agents', () => {
    it('nests sub-agents under Cortana with a ↳ prefix', async () => {
      const cortana = makeAgent();
      const turn = await beginTurn(channel, cortana);
      turn.setPhase('executive-assistant', 'planning', 'consulting Argus and Aphrodite', cortana);
      turn.setPhase('qa', 'working', 'writing tests', argus);
      turn.setPhase('ux-reviewer', 'working', 'reviewing layout', aphrodite);

      const body = await flushAndGetLastBody();

      // Cortana (owner) shows "Thinking…" header at the top with the live
      // activity as italic subtext. Sub-agents indent under her with their
      // names — they're identified by name, not by avatar like the owner.
      const lines = body.split('\n');
      expect(lines[0]).toMatch(/^\*\*Thinking…\*\*/);
      expect(lines[1]).toMatch(/^_consulting Argus and Aphrodite_/);
      expect(lines.some((l) => l.startsWith('  ↳ **Argus**'))).toBe(true);
      expect(lines.some((l) => l.startsWith('  ↳ **Aphrodite**'))).toBe(true);
      // No "(Role)" parenthetical — short role name only
      expect(body).not.toContain('(QA)');
      expect(body).not.toContain('(UX Reviewer)');
    });

    it('renders tool lines indented under their agent', async () => {
      const cortana = makeAgent();
      const turn = await beginTurn(channel, cortana);
      turn.setPhase('qa', 'working', 'running tests', argus);
      turn.addTool('qa', 'run_tests', 'smoke pack', 'done', argus);
      turn.addTool('qa', 'read_file', 'src/index.ts', 'start', argus);

      const body = await flushAndGetLastBody();

      // Owner tools would be at "  •", sub-agent tools at "      •".
      // Only the `summary` argument renders — the tool name routes to emoji
      // choice (which this layer strips) so the line reads just "• smoke pack".
      expect(body).toContain('      • smoke pack ✓');
      expect(body).toContain('      • src/index.ts');
      // running entry has no done marker
      expect(body).not.toContain('      • src/index.ts ✓');
    });

    it('shows a ✓ beside a section header when its phase is done', async () => {
      const cortana = makeAgent();
      const turn = await beginTurn(channel, cortana);
      turn.setPhase('qa', 'done', 'done', argus);

      const body = await flushAndGetLastBody();
      expect(body).toContain('  ↳ **Argus** — done ✓');
    });
  });

  describe('finalize + remove', () => {
    it('finalize edits the tracked message into the final content', async () => {
      const cortana = makeAgent();
      const turn = await beginTurn(channel, cortana);
      await new Promise((r) => setTimeout(r, 550));

      const msg = await turn.finalize('Here is the answer.');

      expect(mockEditWebhookMessage).toHaveBeenCalledWith(
        channel,
        'msg_abc',
        'Here is the answer.',
      );
      expect(msg).toEqual({ id: 'msg_abc', channelId: 'chan_123' });
      expect(turn.isFinalized).toBe(true);
    });

    it('truncates oversized final content with an ellipsis', async () => {
      const cortana = makeAgent();
      const turn = await beginTurn(channel, cortana);
      await new Promise((r) => setTimeout(r, 550));

      const giant = 'x'.repeat(3000);
      await turn.finalize(giant);

      const call = mockEditWebhookMessage.mock.calls.at(-1) as unknown[];
      const content = call[2] as string;
      expect(content.length).toBeLessThanOrEqual(1900);
      expect(content.endsWith('…')).toBe(true);
    });

    it('remove deletes the message and prevents further renders', async () => {
      const deleted = jest.fn().mockResolvedValue(undefined);
      mockSendWebhookMessage.mockResolvedValue({
        id: 'msg_abc',
        channelId: 'chan_123',
        delete: deleted,
      });

      const cortana = makeAgent();
      const turn = await beginTurn(channel, cortana);
      await new Promise((r) => setTimeout(r, 550));
      await turn.remove();

      expect(deleted).toHaveBeenCalled();
      expect(turn.isFinalized).toBe(true);

      // Further updates should be no-ops.
      turn.setPhase('qa', 'working', 'ignored', argus);
      await new Promise((r) => setTimeout(r, 550));
      // No additional edits should have fired after remove.
      expect(mockEditWebhookMessage.mock.calls.length).toBe(0);
    });
  });
});
