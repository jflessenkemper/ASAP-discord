const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test-id' });
jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockReturnValue({ sendMail: mockSendMail }),
}));

import {
  generateCode,
  sendTwoFactorCode,
  sendQuoteNotification,
  sendOwnerNotification,
  sendJobApplication,
  sendBusinessWelcome,
} from '../../services/email';

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

describe('Email Service — sendTwoFactorCode', () => {
  beforeEach(() => mockSendMail.mockClear());

  it('sends an email with the code in HTML', async () => {
    await sendTwoFactorCode('user@example.com', '123456');
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const call = mockSendMail.mock.calls[0][0];
    expect(call.to).toBe('user@example.com');
    expect(call.subject).toBe('Your ASAP Login Code');
    expect(call.html).toContain('123456');
  });
});

describe('Email Service — sendQuoteNotification', () => {
  beforeEach(() => mockSendMail.mockClear());

  it('sends a quote notification with sanitized inputs', async () => {
    await sendQuoteNotification('biz@example.com', 'Acme<script>', 'Fix my <roof>', 'Jane<b>');
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const call = mockSendMail.mock.calls[0][0];
    expect(call.to).toBe('biz@example.com');
    expect(call.subject).toContain('Jane');
    expect(call.html).not.toContain('<script>');
    expect(call.html).not.toContain('<roof>');
    expect(call.html).toContain('Acme');
  });
});

describe('Email Service — sendOwnerNotification', () => {
  beforeEach(() => mockSendMail.mockClear());

  it('sends an owner notification with rating and sanitized fields', async () => {
    await sendOwnerNotification('plumber near me', 'Joe Plumbing<br>', '123 Main St', 4.5, 'Alice');
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const call = mockSendMail.mock.calls[0][0];
    expect(call.to).toBe('jordan.flessenkemper@gmail.com');
    expect(call.subject).toContain('plumber near me');
    expect(call.html).toContain('4.5');
    expect(call.html).toContain('Alice');
    expect(call.html).not.toContain('<br>');
  });

  it('handles empty clientName', async () => {
    await sendOwnerNotification('query', 'Biz', '123 St', 3.0, '');
    const call = mockSendMail.mock.calls[0][0];
    // Empty safeName means the conditional block is skipped
    expect(call.html).toBeDefined();
  });
});

describe('Email Service — sendJobApplication', () => {
  beforeEach(() => mockSendMail.mockClear());

  it('sends a job application with text body', async () => {
    await sendJobApplication(
      'hr@company.com', 'John Doe', 'john@email.com',
      'Software Engineer', 'TechCorp',
      'Cover letter text', 'Highlights', 'https://listing.com/123'
    );
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const call = mockSendMail.mock.calls[0][0];
    expect(call.to).toBe('hr@company.com');
    expect(call.replyTo).toBe('john@email.com');
    expect(call.subject).toContain('Software Engineer');
    expect(call.text).toContain('Cover letter text');
    expect(call.text).toContain('Highlights');
    expect(call.text).toContain('https://listing.com/123');
  });

  it('includes phone when provided', async () => {
    await sendJobApplication(
      'hr@co.com', 'Jane', 'j@e.com', 'Dev', 'Co',
      'Letter', 'Skills', 'https://l.com', '0412345678'
    );
    const call = mockSendMail.mock.calls[0][0];
    expect(call.text).toContain('Phone: 0412345678');
  });

  it('omits phone line when not provided', async () => {
    await sendJobApplication(
      'hr@co.com', 'Jane', 'j@e.com', 'Dev', 'Co',
      'Letter', 'Skills', 'https://l.com'
    );
    const call = mockSendMail.mock.calls[0][0];
    expect(call.text).not.toContain('Phone:');
  });
});

describe('Email Service — sendBusinessWelcome', () => {
  beforeEach(() => mockSendMail.mockClear());

  it('sends a welcome email with access code', async () => {
    await sendBusinessWelcome('owner@biz.com', 'My Biz<>', 'ABC123');
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const call = mockSendMail.mock.calls[0][0];
    expect(call.to).toBe('owner@biz.com');
    expect(call.subject).toContain('Welcome to ASAP');
    expect(call.html).toContain('ABC123');
    expect(call.html).toContain('My Biz');
    expect(call.html).not.toContain('<>');
  });
});
