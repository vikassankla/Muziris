// Public interface of the notifications module (ADR 0020). Other modules import only from here.
export { MAIL_ENV_NAMES, mailConfigFromEnv, type MailConfig } from './config.js';
export {
  NOTIFICATION_KINDS,
  OUTBOX_STATUSES,
  SUPPRESSION_REASONS,
  SUPPRESSION_SOURCES,
  type NotificationKind,
  type OutboxStatus,
  type SuppressionReason,
  type SuppressionSource,
} from './db/schema.js';
export {
  listEmails,
  isRecipientRefused,
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
export { ORDER_EMAIL_SETTING } from './settings.js';
export {
  addSuppression,
  applyPostmarkEvent,
  findSuppression,
  listSuppressions,
  normalizeEmail,
  OUTBOX_METADATA_KEY,
  readPostmarkEvent,
  removeSuppression,
  SuppressionError,
  type ListSuppressionsQuery,
  type PostmarkEvent,
  type PostmarkEventResult,
  type Suppression,
  type SuppressionErrorCode,
  type SuppressionPage,
} from './suppression.js';
export {
  POSTMARK_ENV_NAMES,
  POSTMARK_SMTP_HOST,
  postmarkConfigFromEnv,
  postmarkHeaders,
  webhookCredentialsMatch,
  type PostmarkConfig,
  type PostmarkWebhookCredentials,
} from './postmark.js';
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
