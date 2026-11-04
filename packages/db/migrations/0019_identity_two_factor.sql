CREATE TYPE "public"."identity_session_stage" AS ENUM('full', 'two_factor');--> statement-breakpoint
CREATE TABLE "identity_recovery_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_recovery_code_user_hash_uq" UNIQUE("user_id","code_hash"),
	CONSTRAINT "identity_recovery_code_hash_shape" CHECK ("identity_recovery_code"."code_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "identity_two_factor" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"secret_enc" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_step" bigint,
	"replacement_secret_enc" text,
	"recovery_code_salt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_two_factor_secret_shape" CHECK ("identity_two_factor"."secret_enc" like 'v1:%'),
	CONSTRAINT "identity_two_factor_replacement_shape" CHECK ("identity_two_factor"."replacement_secret_enc" is null or "identity_two_factor"."replacement_secret_enc" like 'v1:%')
);
--> statement-breakpoint
ALTER TABLE "identity_session" ADD COLUMN "stage" "identity_session_stage" DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_recovery_code" ADD CONSTRAINT "identity_recovery_code_user_id_identity_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."identity_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_two_factor" ADD CONSTRAINT "identity_two_factor_user_id_identity_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."identity_user"("id") ON DELETE cascade ON UPDATE no action;