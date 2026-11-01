// Public interface of the notifications module (ADR 0020). Other modules import only from here.
export { MAIL_ENV_NAMES, mailConfigFromEnv, type MailConfig } from './config.js';
export {
  NOTIFICATION_KINDS,
  OUTBOX_STATUSES,
  type NotificationKind,
  type OutboxStatus,
} from './db/schema.js';
export {
  listEmails,
  MAX_ATTEMPTS,
  NotificationError,
  queueEmail,
  retryEmail,
  RETRY_DELAYS_MINUTES,
  sendDueEmails,
  sendErrorCode,
  type EmailPage,
  type Executor,
  type ListEmailsQuery,
  type MailMessage,
  type MailTransport,
  type NotificationErrorCode,
  type OutboxEmail,
  type QueueEmailInput,
  type SendResult,
} from './outbox.js';
export { smtpTransport } from './smtp.js';
export {
  escapeHtml,
  renderEmail,
  SENSITIVE_KINDS,
  type EmailContext,
  type EmailData,
  type Money,
  type RenderedEmail,
} from './templates.js';
