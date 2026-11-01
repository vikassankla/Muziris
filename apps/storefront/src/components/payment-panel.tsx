import { useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { runOperation } from '../lib/api.js';
import { formatPrice } from '../lib/format.js';
import { loadStripe, openRazorpay, type StripeJs } from '../lib/gateways.js';
import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_TONES,
  type PaymentMethod,
  type PaymentStatus,
} from '../lib/orders.js';
import { CheckPayment, StartPayment } from '../operations/generated.js';
import { ErrorState } from './states.js';
import { Alert } from './ui/alert.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';

// Paying an order online (ADR 0019): the gateway's own form, then the status as the gateway
// reports it to the API. What the browser sees from the gateway is never taken as proof of
// payment; the page asks the API, which asks the gateway.

type Step =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'stripe'; stripe: StripeJs; elements: ReturnType<StripeJs['elements']> }
  | { kind: 'confirming' }
  | { kind: 'checking' };

export function PaymentPanel({
  orderNumber,
  method,
  initialStatus,
  total,
  locale,
  shopName,
}: {
  orderNumber: string;
  method: Exclude<PaymentMethod, 'TERMS'>;
  initialStatus: PaymentStatus;
  total: { amount: string; currency: string };
  locale: string;
  shopName: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [problem, setProblem] = useState<{ message?: string; error?: unknown }>();
  const mount = useRef<HTMLDivElement>(null);

  async function check() {
    setStep({ kind: 'checking' });
    try {
      const { checkPayment } = await runOperation(CheckPayment, { orderNumber });
      if (checkPayment.payment) {
        setStatus(checkPayment.payment.status);
        if (checkPayment.payment.status !== initialStatus) void router.invalidate();
      }
    } catch {
      // Still pending as far as this page knows; the webhook will settle it.
    } finally {
      setStep({ kind: 'idle' });
    }
  }

  // Back from the gateway, or a slow webhook: ask once whether the payment came in.
  useEffect(() => {
    if (initialStatus !== 'PENDING') return undefined;
    let live = true;
    runOperation(CheckPayment, { orderNumber }).then(
      ({ checkPayment }) => {
        const now = checkPayment.payment?.status;
        if (!live || now === undefined || now === initialStatus) return;
        setStatus(now);
        void router.invalidate();
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [initialStatus, orderNumber, router]);

  // Stripe's Payment Element mounts once its step is shown.
  useEffect(() => {
    if (step.kind !== 'stripe' || !mount.current) return undefined;
    const element = step.elements.create('payment');
    element.mount(mount.current);
    return () => {
      element.destroy();
    };
  }, [step]);

  async function pay() {
    setStep({ kind: 'starting' });
    setProblem(undefined);
    try {
      const { startPayment } = await runOperation(StartPayment, { orderNumber });
      if (startPayment.refusal) {
        setProblem({ message: startPayment.refusal.message });
        setStep({ kind: 'idle' });
        return;
      }
      if (startPayment.stripe) {
        const stripe = await loadStripe(startPayment.stripe.publishableKey);
        const elements = stripe.elements({ clientSecret: startPayment.stripe.clientSecret });
        setStep({ kind: 'stripe', stripe, elements });
        return;
      }
      if (startPayment.razorpay?.amount) {
        const { keyId, orderId, amount } = startPayment.razorpay;
        await openRazorpay({
          key: keyId,
          order_id: orderId,
          amount: Number(amount.minorUnits),
          currency: amount.currency,
          name: shopName,
          description: `Order ${orderNumber}`,
          handler: () => void check(),
          modal: {
            ondismiss: () => {
              setStep({ kind: 'idle' });
            },
          },
        });
        return;
      }
      setStep({ kind: 'idle' });
    } catch (error) {
      setProblem({ error });
      setStep({ kind: 'idle' });
    }
  }

  async function confirmStripe() {
    if (step.kind !== 'stripe') return;
    const { stripe, elements } = step;
    setStep({ kind: 'confirming' });
    // Stripe sends the buyer back here; the page then asks the API for the status.
    const result = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: `${window.location.origin}/orders/${orderNumber}` },
    });
    if (result.error) {
      setProblem({ message: result.error.message ?? 'The payment did not go through.' });
      setStep({ kind: 'stripe', stripe, elements });
    }
  }

  const payable = status === 'PENDING' || status === 'FAILED';
  const busy = step.kind === 'starting' || step.kind === 'confirming' || step.kind === 'checking';

  return (
    <div className="flex flex-col gap-2.5">
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-meta">
        <dt className="text-muted-foreground">Method</dt>
        <dd className="m-0">{PAYMENT_METHOD_LABELS[method]}</dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd className="m-0">
          <Badge variant={PAYMENT_STATUS_TONES[status]}>{PAYMENT_STATUS_LABELS[status]}</Badge>
        </dd>
      </dl>
      {problem?.message ? <Alert variant="warning">{problem.message}</Alert> : null}
      {problem?.error ? <ErrorState error={problem.error} /> : null}
      {step.kind === 'stripe' || step.kind === 'confirming' ? (
        <>
          <div ref={mount} className="min-h-[120px]" />
          <Button disabled={step.kind === 'confirming'} onClick={() => void confirmStripe()}>
            {step.kind === 'confirming' ? 'Paying…' : `Pay ${formatPrice(total, locale)}`}
          </Button>
        </>
      ) : payable ? (
        <Button disabled={busy} onClick={() => void pay()}>
          {step.kind === 'checking'
            ? 'Checking payment…'
            : `Pay now · ${formatPrice(total, locale)}`}
        </Button>
      ) : null}
    </div>
  );
}
