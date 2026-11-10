// Public interface of the payments module (ADR 0019). Other modules import only from here.
export { webhookActivity, type WebhookActivity } from './activity.js';
export {
  configuredMethods,
  PAYMENT_ENV_NAMES,
  paymentGatewaysFromEnv,
  type PaymentGateways,
  type RazorpayConfig,
  type StripeConfig,
} from './config.js';
export { GATEWAYS, PAYMENT_STATUSES, type Gateway, type PaymentStatus } from './db/schema.js';
export { EventError, readRazorpayEvent, readStripeEvent, type GatewayEvent } from './events.js';
export {
  createGatewayClients,
  GatewayError,
  type GatewayClients,
  type GatewayState,
} from './gateways.js';
export {
  applyGatewayEvent,
  checkPayment,
  findPaymentByGatewayRef,
  findPaymentForOrder,
  listPaymentTransactions,
  nextStatus,
  startPayment,
  type ApplyEventResult,
  type CheckPaymentResult,
  type Payment,
  type PaymentHooks,
  type PaymentRefusalCode,
  type PaymentStart,
  type PaymentTransaction,
  type StartPaymentResult,
} from './payments.js';
export { verifyRazorpaySignature, verifyStripeSignature } from './signatures.js';
