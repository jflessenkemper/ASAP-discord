import { generateCode } from '../../services/email';

describe('Email Service — generateCode', () => {
  it('returns a 6-digit string', () => {
    const code = generateCode();
    expect(code).toMatch(/^\d{6}$/);
  });

  it('returns codes within the correct range (100000-999999)', () => {
    for (let i = 0; i < 100; i++) {
      const code = generateCode();
      const num = parseInt(code, 10);
      expect(num).toBeGreaterThanOrEqual(100000);
      expect(num).toBeLessThan(1000000);
    }
  });

  it('generates different codes (not deterministic)', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      codes.add(generateCode());
    }
    // With 20 samples of 6-digit codes, we should get many unique values
    expect(codes.size).toBeGreaterThan(5);
  });
});
