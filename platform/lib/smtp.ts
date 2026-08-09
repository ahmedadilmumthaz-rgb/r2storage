import nodemailer from 'nodemailer';
import { ENV } from './env';

export function isSmtpConfigured(): boolean {
  return !!(ENV.SMTP_HOST && ENV.SMTP_USER);
}

async function transport(): Promise<nodemailer.Transporter | null> {
  if (!isSmtpConfigured()) return null;
  return nodemailer.createTransport({
    host: ENV.SMTP_HOST,
    port: ENV.SMTP_PORT,
    secure: ENV.SMTP_PORT === 465,
    auth: { user: ENV.SMTP_USER, pass: ENV.SMTP_PASS },
  });
}

// Returns false when SMTP isn't configured (caller falls back to dashboard).
export async function sendMail(to: string, subject: string, html: string, text: string): Promise<boolean> {
  const t = await transport();
  if (!t) {
    console.log(`[mail] (SMTP not configured) to=${to} subject="${subject}"`);
    return false;
  }
  await t.sendMail({ from: ENV.SMTP_FROM, to, subject, html, text });
  console.log(`[mail] sent to=${to} subject="${subject}"`);
  return true;
}
