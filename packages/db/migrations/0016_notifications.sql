CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"recipient" text NOT NULL,
	"locale" text NOT NULL,
	"subject" text NOT NULL,
	"text_body" text NOT NULL,
	"html_body" text NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "notification_outbox_kind" CHECK ("notification_outbox"."kind" in ('buyer_invitation', 'order_placed', 'order_received', 'order_confirmed', 'order_declined', 'order_completed', 'payment_received', 'payment_failed')),
	CONSTRAINT "notification_outbox_status" CHECK ("notification_outbox"."status" in ('queued', 'sent', 'failed')),
	CONSTRAINT "notification_outbox_attempts" CHECK ("notification_outbox"."attempts" >= 0),
	CONSTRAINT "notification_outbox_recipient_shape" CHECK ("notification_outbox"."recipient" ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
	CONSTRAINT "notification_outbox_sent_at" CHECK (("notification_outbox"."status" = 'sent') = ("notification_outbox"."sent_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_key_uq" ON "notification_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "notification_outbox_due_idx" ON "notification_outbox" USING btree ("next_attempt_at") WHERE "notification_outbox"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "notification_outbox_status_idx" ON "notification_outbox" USING btree ("status","created_at");