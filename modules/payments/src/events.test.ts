import { describe, expect, it } from 'vitest';
import { EventError, readRazorpayEvent, readStripeEvent } from './events.js';
import { nextStatus } from './payments.js';

const intent = (type: string, object: object) =>
  JSON.stringify({ id: 'evt_1', type, data: { object } });

describe('readStripeEvent', () => {
  it('reads a succeeded PaymentIntent as paid, for the amount received', () => {
    expect(
      readStripeEvent(
        intent('payment_intent.succeeded', {
          id: 'pi_1',
          amount: 1250,
          amount_received: 1250,
          currency: 'usd',
        }),
      ),
    ).toEqual({
      eventId: 'evt_1',
      eventType: 'payment_intent.succeeded',
      ref: 'pi_1',
      amountMinor: 1250n,
      currency: 'USD',
      effect: { kind: 'status', status: 'paid' },
    });
  });

  it('reads a refunded charge as the total refunded on its PaymentIntent', () => {
    expect(
      readStripeEvent(
        intent('charge.refunded', {
          payment_intent: 'pi_1',
          amount_refunded: 500,
          currency: 'usd',
        }),
      ),
    ).toMatchObject({ ref: 'pi_1', effect: { kind: 'refund', refundedMinor: 500n } });
  });

  it('keeps other events with no effect, and refuses a body it cannot read', () => {
    expect(readStripeEvent(intent('customer.created', { id: 'cus_1' })).effect).toEqual({
      kind: 'none',
    });
    expect(() => readStripeEvent('not json')).toThrow(EventError);
    expect(() =>
      readStripeEvent(
        intent('payment_intent.succeeded', { id: 'pi_1', amount: -1, currency: 'usd' }),
      ),
    ).toThrow(EventError);
  });
});

describe('readRazorpayEvent', () => {
  it('takes the event id from the header and the order from the payment', () => {
    const body = JSON.stringify({
      event: 'payment.failed',
      payload: { payment: { entity: { order_id: 'order_1', amount: 96000, currency: 'INR' } } },
    });
    expect(readRazorpayEvent(body, 'evt_9')).toEqual({
      eventId: 'evt_9',
      eventType: 'payment.failed',
      ref: 'order_1',
      amountMinor: 96000n,
      currency: 'INR',
      effect: { kind: 'status', status: 'failed' },
    });
    expect(() => readRazorpayEvent(body, undefined)).toThrow(EventError);
  });

  it('reads order.paid for the amount paid', () => {
    const body = JSON.stringify({
      event: 'order.paid',
      payload: { order: { entity: { id: 'order_1', amount_paid: 96000, currency: 'INR' } } },
    });
    expect(readRazorpayEvent(body, 'e').effect).toEqual({ kind: 'status', status: 'paid' });
  });
});

describe('nextStatus', () => {
  const p = (status: Parameters<typeof nextStatus>[0]['status'], refundedMinor = 0n) => ({
    status,
    amountMinor: 1000n,
    refundedMinor,
  });
  const paid = { kind: 'status', status: 'paid' } as const;
  const failed = { kind: 'status', status: 'failed' } as const;
  const refund = (n: bigint) => ({ kind: 'refund', refundedMinor: n }) as const;

  it.each([
    ['pending', paid, 'paid'],
    ['failed', paid, 'paid'],
    ['pending', failed, 'failed'],
    ['paid', failed, 'paid'],
    ['refunded', paid, 'refunded'],
    ['pending', refund(500n), 'pending'],
    ['paid', refund(500n), 'partially_refunded'],
    ['paid', refund(1000n), 'refunded'],
  ] as const)('%s with %j becomes %s', (from, effect, to) => {
    expect(nextStatus(p(from), effect).status).toBe(to);
  });

  it('ignores a refund total lower than one already recorded', () => {
    expect(nextStatus(p('partially_refunded', 600n), refund(500n))).toEqual({
      status: 'partially_refunded',
      refundedMinor: 600n,
    });
  });
});
