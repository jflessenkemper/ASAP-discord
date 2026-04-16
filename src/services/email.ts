import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

export async function sendJobApplication(
  toEmail: string,
  fromName: string,
  replyToEmail: string,
  jobTitle: string,
  company: string,
  coverLetter: string,
  resumeHighlights: string,
  listingUrl: string,
  phone?: string,
): Promise<void> {
  const safeTitle = jobTitle.replace(/[<>]/g, '').slice(0, 200);
  const safeCompany = company.replace(/[<>]/g, '').slice(0, 100);

  const textBody = [
    coverLetter,
    '',
    '---',
    '',
    'Key Qualifications:',
    resumeHighlights,
    '',
    '---',
    `Listing: ${listingUrl}`,
    '',
    `${fromName}`,
    phone ? `Phone: ${phone}` : '',
    `Email: ${replyToEmail}`,
  ].filter(Boolean).join('\n');

  await transporter.sendMail({
    from: `"${fromName}" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    replyTo: replyToEmail,
    subject: `Application: ${safeTitle} — ${fromName}`,
    text: textBody,
  });
}
