import { createTransport } from 'nodemailer';
import type { MailTransport } from './outbox.js';

/**
 * Sends over SMTP with nodemailer (ADR 0020). The URL carries the host, port, TLS and any
 * credentials. Connections are pooled and time out, so a stuck server cannot hold the sender.
 */
export function smtpTransport(smtpUrl: string, from: string): MailTransport & { close(): void } {
  const transporter = createTransport(smtpUrl, { from });
  return {
    async send(message) {
      await transporter.sendMail({
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    },
    close() {
      transporter.close();
    },
  };
}
