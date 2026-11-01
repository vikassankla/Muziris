CREATE TABLE "payment_transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "payment_transaction_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"payment_id" uuid,
	"gateway" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"gateway_ref" text,
	"amount_minor" bigint,
	"currency" text,
	"outcome" text NOT NULL,
	"status_after" text,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_transaction_event_uq" UNIQUE("gateway","event_id"),
	CONSTRAINT "payment_transaction_outcome" CHECK ("payment_transaction"."outcome" in ('applied', 'ignored', 'amount_mismatch', 'unknown_payment'))
);
--> statement-breakpoint
CREATE TABLE "payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"method" text NOT NULL,
	"gateway" text NOT NULL,
	"gateway_ref" text,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"refunded_minor" bigint DEFAULT 0 NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_order_uq" UNIQUE("order_id"),
	CONSTRAINT "payment_gateway_ref_uq" UNIQUE("gateway","gateway_ref"),
	CONSTRAINT "payment_gateway" CHECK ("payment"."gateway" in ('stripe', 'razorpay')),
	CONSTRAINT "payment_status" CHECK ("payment"."status" in ('pending', 'paid', 'failed', 'cancelled', 'refunded', 'partially_refunded')),
	CONSTRAINT "payment_currency_format" CHECK ("payment"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payment_amounts" CHECK ("payment"."amount_minor" > 0 and "payment"."refunded_minor" between 0 and "payment"."amount_minor")
);
--> statement-breakpoint
ALTER TABLE "orders_order" DROP CONSTRAINT "orders_order_payment_method";--> statement-breakpoint
ALTER TABLE "orders_order" ALTER COLUMN "due_on" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_transaction" ADD CONSTRAINT "payment_transaction_payment_id_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_transaction_payment_idx" ON "payment_transaction" USING btree ("payment_id","seq");--> statement-breakpoint
ALTER TABLE "orders_order" ADD CONSTRAINT "orders_order_due_on_terms" CHECK (("orders_order"."payment_method" = 'terms') = ("orders_order"."due_on" is not null));--> statement-breakpoint
ALTER TABLE "orders_order" ADD CONSTRAINT "orders_order_payment_method" CHECK ("orders_order"."payment_method" in ('terms', 'stripe_card', 'stripe_ach', 'razorpay'));