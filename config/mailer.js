import nodemailer from "nodemailer";

// SMTP settings come from .env. Any SMTP provider works (Gmail app password, Brevo, Resend, Zoho, SES…).
const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE, MAIL_FROM } = process.env;

export const isMailConfigured = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);

const transporter = isMailConfigured
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT) || 587,
      secure: SMTP_SECURE ? SMTP_SECURE === "true" : Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    })
  : null;

/**
 * Sends an email. Without SMTP settings, development builds print the message to the
 * console instead (so flows like password reset can be tested locally); production throws.
 */
export async function sendMail({ to, subject, text, html }) {
  if (!transporter) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Email is not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS).");
    }
    console.log(`\n[mail:dev] SMTP not configured — email not sent.\nTo: ${to}\nSubject: ${subject}\n${text}\n`);
    return { delivered: false };
  }

  await transporter.sendMail({ from: MAIL_FROM || SMTP_USER, to, subject, text, html });
  return { delivered: true };
}
