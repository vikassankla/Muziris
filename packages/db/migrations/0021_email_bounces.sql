CREATE TABLE "notification_bounce_event" (
	"postmark_id" bigint PRIMARY KEY NOT NULL,
	"record_type" text NOT NULL,
	"bounce_type" text NOT NULL,
	"bounce_type_code" integer NOT NULL,
	"outbox_id" uuid,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "notification_bounce_event_record_type" CHECK ("notification_bounce_event"."record_type" in ('Bounce', 'SpamComplaint'))
);
--> statement-breakpoint
CREATE TABLE "notification_suppression" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"bounce_type" text,
	"bounce_type_code" integer,
	"outbox_id" uuid,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "notification_suppression_reason" CHECK ("notification_suppression"."reason" in ('hard_bounce', 'spam_complaint', 'smtp_rejected', 'manual')),
	CONSTRAINT "notification_suppression_source" CHECK ("notification_suppression"."source" in ('postmark', 'smtp', 'admin')),
	CONSTRAINT "notification_suppression_email_shape" CHECK ("notification_suppression"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
	CONSTRAINT "notification_suppression_seen" CHECK ("notification_suppression"."last_seen_at" >= "notification_suppression"."first_seen_at")
);
--> statement-breakpoint
ALTER TABLE "notification_outbox" DROP CONSTRAINT "notification_outbox_status";--> statement-breakpoint
ALTER TABLE "notification_outbox" DROP CONSTRAINT "notification_outbox_sent_at";--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "bounce_type" text;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_suppression_email_uq" ON "notification_suppression" USING btree ("email");--> statement-breakpoint
CREATE INDEX "notification_suppression_recent_idx" ON "notification_suppression" USING btree ("first_seen_at","id");--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_bounce_type" CHECK (("notification_outbox"."status" = 'bounced') = ("notification_outbox"."bounce_type" is not null));--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_status" CHECK ("notification_outbox"."status" in ('queued', 'sent', 'failed', 'bounced', 'suppressed'));--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_sent_at" CHECK (("notification_outbox"."status" in ('sent', 'bounced')) = ("notification_outbox"."sent_at" is not null));