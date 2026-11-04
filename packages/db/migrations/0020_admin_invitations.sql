CREATE TABLE "identity_invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "identity_invitation_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "identity_invitation_token_hash_shape" CHECK ("identity_invitation"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "identity_invitation_expiry_after_creation" CHECK ("identity_invitation"."expires_at" > "identity_invitation"."created_at")
);
--> statement-breakpoint
ALTER TABLE "notification_outbox" DROP CONSTRAINT "notification_outbox_kind";--> statement-breakpoint
ALTER TABLE "identity_invitation" ADD CONSTRAINT "identity_invitation_user_id_identity_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."identity_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_invitation_open_uq" ON "identity_invitation" USING btree ("user_id") WHERE "identity_invitation"."accepted_at" is null and "identity_invitation"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_kind" CHECK ("notification_outbox"."kind" in ('buyer_invitation', 'admin_invitation', 'order_placed', 'order_received', 'order_confirmed', 'order_declined', 'order_completed', 'payment_received', 'payment_failed'));