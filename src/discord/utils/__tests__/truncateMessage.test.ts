import { truncateMessage } from '../truncateMessage';

describe('truncateMessage', () => {
  it('returns short strings unchanged', () => {
    expect(truncateMessage('hello')).toBe('hello');
  });

  it('returns a string exactly at the limit unchanged', () => {
    const exact = 'a'.repeat(2000);
    expect(truncateMessage(exact)).toBe(exact);
    expect(truncateMessage(exact).length).toBe(2000);
  });

  it('truncates a long string to ≤ 2000 chars by default', () => {
    const long = 'word '.repeat(500); // 2500 chars
    const result = truncateMessage(long);
    expect(result.length).toBeLessThanOrEqual(2000);
    expect(result.endsWith('…')).toBe(true);
  });

  it('breaks at a word boundary', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    const result = truncateMessage(text, { maxLength: 20 });
    // budget = 19; slice = "The quick brown fox"; lastSpace = 15 (before "fox")
    // 15 > 19*0.2 (3.8), so breaks at word boundary before "fox"
    expect(result).toBe('The quick brown…');
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it('respects a custom maxLength', () => {
    const text = 'abcdefghij';
    const result = truncateMessage(text, { maxLength: 5 });
    expect(result.length).toBeLessThanOrEqual(5);
    expect(result.endsWith('…')).toBe(true);
  });

  it('respects a custom suffix', () => {
    const text = 'a]'.repeat(100);
    const result = truncateMessage(text, { maxLength: 10, suffix: '...' });
    expect(result.endsWith('...')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it('handles no-space strings gracefully (hard cut)', () => {
    const text = 'a'.repeat(3000);
    const result = truncateMessage(text, { maxLength: 100 });
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result.endsWith('…')).toBe(true);
  });

  it('throws on maxLength < 1', () => {
    expect(() => truncateMessage('hi', { maxLength: 0 })).toThrow(RangeError);
  });

  it('handles empty string', () => {
    expect(truncateMessage('')).toBe('');
  });

  it('handles suffix longer than maxLength', () => {
    const result = truncateMessage('hello world', { maxLength: 2, suffix: '...' });
    expect(result.length).toBeLessThanOrEqual(2);
  });
});
