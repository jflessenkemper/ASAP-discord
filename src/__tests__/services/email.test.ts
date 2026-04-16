const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test-id' });
jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockReturnValue({ sendMail: mockSendMail }),
}));

import {
  sendJobApplication,
} from '../../services/email';

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
