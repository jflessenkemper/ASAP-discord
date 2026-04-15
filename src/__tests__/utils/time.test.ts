import { formatAge } from '../../utils/time';

describe('formatAge', () => {
  it('returns "0s" for zero', () => {
    expect(formatAge(0)).toBe('0s');
  });

  it('returns "0s" for negative values', () => {
    expect(formatAge(-1000)).toBe('0s');
  });

  it('returns "0s" for NaN', () => {
    expect(formatAge(NaN)).toBe('0s');
  });

  it('returns "0s" for Infinity', () => {
    expect(formatAge(Infinity)).toBe('0s');
  });

  it('returns seconds for sub-minute durations', () => {
    expect(formatAge(1000)).toBe('1s');
    expect(formatAge(30_000)).toBe('30s');
    expect(formatAge(59_999)).toBe('60s');
  });

  it('returns at least 1s for tiny positive values', () => {
    expect(formatAge(1)).toBe('1s');
    expect(formatAge(100)).toBe('1s');
  });

  it('returns minutes for sub-hour durations', () => {
    expect(formatAge(60_000)).toBe('1m');
    expect(formatAge(300_000)).toBe('5m');
    expect(formatAge(3_599_999)).toBe('60m');
  });

  it('returns hours for sub-day durations', () => {
    expect(formatAge(3_600_000)).toBe('1h');
    expect(formatAge(7_200_000)).toBe('2h');
    expect(formatAge(86_399_999)).toBe('24h');
  });

  it('returns days for large durations', () => {
    expect(formatAge(86_400_000)).toBe('1d');
    expect(formatAge(172_800_000)).toBe('2d');
    expect(formatAge(604_800_000)).toBe('7d');
  });
});
