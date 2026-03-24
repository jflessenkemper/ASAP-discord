import nodemailer from 'nodemailer';
import { randomInt } from 'crypto';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

export function generateCode(): string {
  return randomInt(100000, 1000000).toString();
}

export async function sendTwoFactorCode(email: string, code: string): Promise<void> {
  await transporter.sendMail({
    from: `"ASAP Tech Support" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: 'Your ASAP Login Code',
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
      <body style="margin: 0; padding: 0; background-color: #121212; font-family: 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #121212; padding: 40px 0;">
          <tr><td align="center">
            <table width="420" cellpadding="0" cellspacing="0" style="background-color: #212121; border-radius: 16px; overflow: hidden; border: 1px solid #2A2A2A;">
              <!-- Header bar -->
              <tr>
                <td style="background: linear-gradient(135deg, #011545, #012169); padding: 28px 32px 24px;">
                  <h1 style="margin: 0; font-size: 36px; font-weight: 700; color: #FFFFFF; letter-spacing: 3px;">ASAP</h1>
                  <p style="margin: 6px 0 0; font-size: 14px; color: rgba(255,255,255,0.85); letter-spacing: 0.5px;">As Soon As Possible</p>
                </td>
              </tr>
              <!-- Body -->
              <tr>
                <td style="padding: 32px;">
                  <p style="margin: 0 0 6px; font-size: 18px; font-weight: 600; color: #FFFFFF;">Employee login verification</p>
                  <p style="margin: 0 0 28px; font-size: 14px; color: #9E9E9E; line-height: 1.5;">Use the code below to complete your sign-in. Don't share this code with anyone.</p>
                  <!-- Code box -->
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr><td align="center" style="background-color: #1A1A1A; border: 1px solid #363636; border-radius: 12px; padding: 28px 20px;">
                      <p style="margin: 0; font-size: 38px; font-weight: 700; letter-spacing: 10px; color: #012169; font-family: 'Courier New', monospace;">${code}</p>
                    </td></tr>
                  </table>
                  <p style="margin: 24px 0 0; font-size: 13px; color: #757575; line-height: 1.5;">This code expires in <strong style="color: #BDBDBD;">10 minutes</strong>.</p>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="padding: 0 32px 28px;">
                  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top: 1px solid #2A2A2A; padding-top: 20px;">
                    <p style="margin: 0; font-size: 12px; color: #616161; line-height: 1.6;">If you didn't request this code, you can safely ignore this email. Your account is secure.</p>
                    <p style="margin: 12px 0 0; font-size: 11px; color: #424242;">&copy; ASAP Tech Support</p>
                  </td></tr></table>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  });
}

export async function sendQuoteNotification(
  businessEmail: string,
  businessName: string,
  description: string,
  clientName: string,
): Promise<void> {
  const safeDesc = description.replace(/[<>]/g, '').slice(0, 500);
  const safeName = clientName.replace(/[<>]/g, '').slice(0, 100);
  const safeBizName = businessName.replace(/[<>]/g, '').slice(0, 100);

  await transporter.sendMail({
    from: `"ASAP" <${process.env.GMAIL_USER}>`,
    to: businessEmail,
    subject: `New quote request on ASAP from ${safeName}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
      <body style="margin: 0; padding: 0; background-color: #121212; font-family: 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #121212; padding: 40px 0;">
          <tr><td align="center">
            <table width="420" cellpadding="0" cellspacing="0" style="background-color: #212121; border-radius: 16px; overflow: hidden; border: 1px solid #2A2A2A;">
              <tr>
                <td style="background: linear-gradient(135deg, #011545, #012169); padding: 28px 32px 24px;">
                  <h1 style="margin: 0; font-size: 36px; font-weight: 700; color: #FFFFFF; letter-spacing: 3px;">ASAP</h1>
                  <p style="margin: 6px 0 0; font-size: 14px; color: rgba(255,255,255,0.85);">New Quote Request</p>
                </td>
              </tr>
              <tr>
                <td style="padding: 32px;">
                  <p style="margin: 0 0 6px; font-size: 18px; font-weight: 600; color: #FFFFFF;">Hi ${safeBizName},</p>
                  <p style="margin: 0 0 20px; font-size: 14px; color: #9E9E9E; line-height: 1.5;">You have a new quote request from <strong style="color: #BDBDBD;">${safeName}</strong>.</p>
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr><td style="background-color: #1A1A1A; border: 1px solid #363636; border-radius: 12px; padding: 20px;">
                      <p style="margin: 0; font-size: 14px; color: #E0E0E0; line-height: 1.6;">${safeDesc}</p>
                    </td></tr>
                  </table>
                  <p style="margin: 20px 0 0; font-size: 14px; color: #9E9E9E;">Log in to your ASAP business dashboard to respond with a quote.</p>
                </td>
              </tr>
              <tr>
                <td style="padding: 0 32px 28px;">
                  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top: 1px solid #2A2A2A; padding-top: 20px;">
                    <p style="margin: 0; font-size: 11px; color: #424242;">&copy; ASAP</p>
                  </td></tr></table>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  });
}

export async function sendOwnerNotification(
  searchQuery: string,
  businessName: string,
  businessAddress: string,
  businessRating: number,
  clientName: string,
): Promise<void> {
  const safeQuery = searchQuery.replace(/[<>]/g, '').slice(0, 500);
  const safeBiz = businessName.replace(/[<>]/g, '').slice(0, 200);
  const safeAddr = businessAddress.replace(/[<>]/g, '').slice(0, 500);
  const safeName = clientName.replace(/[<>]/g, '').slice(0, 100);

  await transporter.sendMail({
    from: `"ASAP" <${process.env.GMAIL_USER}>`,
    to: 'jordan.flessenkemper@gmail.com',
    subject: `ASAP Lead: "${safeQuery}" — ${safeBiz}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
      <body style="margin: 0; padding: 0; background-color: #121212; font-family: 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #121212; padding: 40px 0;">
          <tr><td align="center">
            <table width="420" cellpadding="0" cellspacing="0" style="background-color: #212121; border-radius: 16px; overflow: hidden; border: 1px solid #2A2A2A;">
              <tr>
                <td style="background: linear-gradient(135deg, #011545, #012169); padding: 28px 32px 24px;">
                  <h1 style="margin: 0; font-size: 36px; font-weight: 700; color: #FFFFFF; letter-spacing: 3px;">ASAP</h1>
                  <p style="margin: 6px 0 0; font-size: 14px; color: rgba(255,255,255,0.85);">New Customer Lead</p>
                </td>
              </tr>
              <tr>
                <td style="padding: 32px;">
                  <p style="margin: 0 0 6px; font-size: 18px; font-weight: 600; color: #FFFFFF;">Hey Jordan,</p>
                  <p style="margin: 0 0 20px; font-size: 14px; color: #9E9E9E; line-height: 1.5;">A customer wants to connect about:</p>
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr><td style="background-color: #1A1A1A; border: 1px solid #363636; border-radius: 12px; padding: 20px;">
                      <p style="margin: 0 0 4px; font-size: 12px; color: #757575; text-transform: uppercase; letter-spacing: 1px;">Search Query</p>
                      <p style="margin: 0 0 16px; font-size: 16px; font-weight: 600; color: #E0E0E0;">${safeQuery}</p>
                      <p style="margin: 0 0 4px; font-size: 12px; color: #757575; text-transform: uppercase; letter-spacing: 1px;">Selected Business</p>
                      <p style="margin: 0; font-size: 15px; font-weight: 600; color: #6B9EFF;">${safeBiz}</p>
                      <p style="margin: 4px 0 0; font-size: 13px; color: #9E9E9E;">${safeAddr}</p>
                      <p style="margin: 4px 0 0; font-size: 13px; color: #FFC107;">⭐ ${businessRating.toFixed(1)}</p>
                      ${safeName ? `<p style="margin: 12px 0 0 0; font-size: 12px; color: #757575; text-transform: uppercase; letter-spacing: 1px;">Customer</p><p style="margin: 4px 0 0; font-size: 14px; color: #BDBDBD;">${safeName}</p>` : ''}
                    </td></tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding: 0 32px 28px;">
                  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top: 1px solid #2A2A2A; padding-top: 20px;">
                    <p style="margin: 0; font-size: 11px; color: #424242;">&copy; ASAP</p>
                  </td></tr></table>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  });
}

export async function sendBusinessWelcome(
  email: string,
  businessName: string,
  accessCode: string,
): Promise<void> {
  const safeName = businessName.replace(/[<>]/g, '').slice(0, 100);
  const safeCode = accessCode.replace(/[<>]/g, '').slice(0, 10);

  await transporter.sendMail({
    from: `"ASAP" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: 'Welcome to ASAP — Your business access code',
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
      <body style="margin: 0; padding: 0; background-color: #121212; font-family: 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #121212; padding: 40px 0;">
          <tr><td align="center">
            <table width="420" cellpadding="0" cellspacing="0" style="background-color: #212121; border-radius: 16px; overflow: hidden; border: 1px solid #2A2A2A;">
              <tr>
                <td style="background: linear-gradient(135deg, #011545, #012169); padding: 28px 32px 24px;">
                  <h1 style="margin: 0; font-size: 36px; font-weight: 700; color: #FFFFFF; letter-spacing: 3px;">ASAP</h1>
                  <p style="margin: 6px 0 0; font-size: 14px; color: rgba(255,255,255,0.85);">Welcome aboard!</p>
                </td>
              </tr>
              <tr>
                <td style="padding: 32px;">
                  <p style="margin: 0 0 6px; font-size: 18px; font-weight: 600; color: #FFFFFF;">Welcome, ${safeName}!</p>
                  <p style="margin: 0 0 20px; font-size: 14px; color: #9E9E9E; line-height: 1.5;">Your ASAP business account is ready. Here's your unique access code:</p>
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr><td align="center" style="background-color: #1A1A1A; border: 1px solid #363636; border-radius: 12px; padding: 28px 20px;">
                      <p style="margin: 0; font-size: 38px; font-weight: 700; letter-spacing: 10px; color: #012169; font-family: 'Courier New', monospace;">${safeCode}</p>
                    </td></tr>
                  </table>
                  <p style="margin: 20px 0 0; font-size: 14px; color: #9E9E9E; line-height: 1.5;">Share this code with customers so they can add you as their service provider.</p>
                </td>
              </tr>
              <tr>
                <td style="padding: 0 32px 28px;">
                  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top: 1px solid #2A2A2A; padding-top: 20px;">
                    <p style="margin: 0; font-size: 11px; color: #424242;">&copy; ASAP</p>
                  </td></tr></table>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `,
  });
}
