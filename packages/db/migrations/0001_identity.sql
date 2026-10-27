CREATE TYPE "public"."identity_realm" AS ENUM('admin', 'buyer');--> statement-breakpoint
CREATE TYPE "public"."identity_user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "identity_rate_limit" (
	"key" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"hits" integer NOT NULL,
	CONSTRAINT "identity_rate_limit_hits_positive" CHECK ("identity_rate_limit"."hits" > 0)
);
--> statement-breakpoint
CREATE TABLE "identity_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"realm" "identity_realm" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"ip_address" text,
	CONSTRAINT "identity_session_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "identity_session_token_hash_shape" CHECK ("identity_session"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "identity_session_expiry_after_creation" CHECK ("identity_session"."expires_at" > "identity_session"."created_at")
);
--> statement-breakpoint
CREATE TABLE "identity_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"realm" "identity_realm" NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text,
	"status" "identity_user_status" DEFAULT 'active' NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"password_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_user_realm_email_uq" UNIQUE("realm","email"),
	CONSTRAINT "identity_user_email_lowercase" CHECK ("identity_user"."email" = lower(btrim("identity_user"."email"))),
	CONSTRAINT "identity_user_email_shape" CHECK ("identity_user"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
	CONSTRAINT "identity_user_failed_login_count_nonneg" CHECK ("identity_user"."failed_login_count" >= 0),
	CONSTRAINT "identity_user_password_hash_argon2id" CHECK ("identity_user"."password_hash" is null or "identity_user"."password_hash" like '$argon2id$%')
);
--> statement-breakpoint
ALTER TABLE "identity_session" ADD CONSTRAINT "identity_session_user_id_identity_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."identity_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_rate_limit_window_idx" ON "identity_rate_limit" USING btree ("window_started_at");--> statement-breakpoint
CREATE INDEX "identity_session_user_idx" ON "identity_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "identity_session_expires_idx" ON "identity_session" USING btree ("expires_at");