import { createTransport } from 'nodemailer';
import type { MailTransport } from './outbox.js';
import { postmarkHeaders } from './postmark.js';

/**
 * Sends over SMTP with nodemailer (ADR 0020). The URL carries the host, port, TLS and any
 * credentials. Connections are pooled and time out, so a stuck server cannot hold the sender.
 * Through Postmark, each email names its stream and carries its outbox id (ADR 0032).
 */
export function smtpTransport(
  smtpUrl: string,
  from: string,
  options: { messageStream?: string } = {},
): MailTransport & { close(): void } {
  const transporter = createTransport(smtpUrl, { from });
  const stream = options.messageStream ?? 'outbound';
  return {
    async send(message) {
      await transporter.sendMail({
        headers: postmarkHeaders(smtpUrl, message.outboxId, stream),
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
