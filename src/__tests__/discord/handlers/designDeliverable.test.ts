jest.mock('../../../discord/agents', () => ({
  buildAgentMentionGuide: jest.fn().mockReturnValue('@kane @sophie @max'),
}));

import {
  isDesignDeliverableDetailed,
  shouldSkipContractEnforcement,
  buildAceDesignContext,
  buildAceStandardContext,
} from '../../../discord/handlers/designDeliverable';

describe('isDesignDeliverableDetailed', () => {
  it('detects design spec in cortana response', () => {
    const result = isDesignDeliverableDetailed('Create a design spec for the dashboard', null);
    expect(result.match).toBe(true);
    expect(result.cortanaMatch).toBe(true);
    expect(result.goalMatch).toBe(false);
  });

  it('detects html design in cortana response', () => {
    const result = isDesignDeliverableDetailed('Build a design with HTML and CSS', null);
    expect(result.match).toBe(true);
  });

  it('detects glassmorphism keyword', () => {
    const result = isDesignDeliverableDetailed('Apply glassmorphism effects', null);
    expect(result.match).toBe(true);
  });

  it('detects design in active goal', () => {
    const result = isDesignDeliverableDetailed('other text', 'Create a design spec');
    expect(result.match).toBe(true);
    expect(result.cortanaMatch).toBe(false);
    expect(result.goalMatch).toBe(true);
  });

  it('returns false when no design keywords', () => {
    const result = isDesignDeliverableDetailed('Fix the login bug', 'Deploy to production');
    expect(result.match).toBe(false);
  });

  it('handles null goal', () => {
    const result = isDesignDeliverableDetailed('No match here', null);
    expect(result.match).toBe(false);
    expect(result.goalMatch).toBe(false);
  });
});

describe('shouldSkipContractEnforcement', () => {
  it('skips for design spec', () => {
    expect(shouldSkipContractEnforcement('This is a design spec task')).toBe(true);
  });

  it('skips for glassmorphism', () => {
    expect(shouldSkipContractEnforcement('Apply glassmorphism')).toBe(true);
  });

  it('skips for mockup', () => {
    expect(shouldSkipContractEnforcement('Create a mockup')).toBe(true);
  });

  it('skips for wireframe', () => {
    expect(shouldSkipContractEnforcement('Build a wireframe')).toBe(true);
  });

  it('skips for style guide', () => {
    expect(shouldSkipContractEnforcement('Update the style guide')).toBe(true);
  });

  it('does not skip for normal text', () => {
    expect(shouldSkipContractEnforcement('Fix the API endpoint')).toBe(false);
  });
});

describe('buildAceDesignContext', () => {
  it('includes Cortana directive', () => {
    const ctx = buildAceDesignContext('Build the dashboard page');
    expect(ctx).toContain('[Cortana directed you]: Build the dashboard page');
  });

  it('includes design deliverable instructions', () => {
    const ctx = buildAceDesignContext('test');
    expect(ctx).toContain('design deliverable task');
    expect(ctx).toContain('write_file');
  });

  it('includes mention guide', () => {
    const ctx = buildAceDesignContext('test');
    expect(ctx).toContain('@kane @sophie @max');
  });
});

describe('buildAceStandardContext', () => {
  it('includes Cortana directive', () => {
    const ctx = buildAceStandardContext('Implement feature X');
    expect(ctx).toContain('[Cortana directed you]: Implement feature X');
  });

  it('includes PR workflow instructions', () => {
    const ctx = buildAceStandardContext('test');
    expect(ctx).toContain('branch');
    expect(ctx).toContain('commit');
    expect(ctx).toContain('merge_pull_request');
  });

  it('includes Result/Evidence/Risk format', () => {
    const ctx = buildAceStandardContext('test');
    expect(ctx).toContain('Result:');
    expect(ctx).toContain('Evidence:');
    expect(ctx).toContain('Risk/Follow-up:');
  });

  it('includes mention guide', () => {
    const ctx = buildAceStandardContext('test');
    expect(ctx).toContain('@kane @sophie @max');
  });
});
