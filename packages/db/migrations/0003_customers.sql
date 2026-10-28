CREATE TABLE "customer_address" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"label" text NOT NULL,
	"country_code" text NOT NULL,
	"line1" text NOT NULL,
	"line2" text,
	"city" text NOT NULL,
	"region_code" text NOT NULL,
	"postal_code" text NOT NULL,
	"gstin" text,
	"is_default_billing" boolean DEFAULT false NOT NULL,
	"is_default_shipping" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_address_country" CHECK ("customer_address"."country_code" in ('IN', 'US')),
	CONSTRAINT "customer_address_india_format" CHECK ("customer_address"."country_code" <> 'IN' or ("customer_address"."postal_code" ~ '^[1-9][0-9]{5}$' and "customer_address"."region_code" ~ '^[0-9]{2}$')),
	CONSTRAINT "customer_address_us_format" CHECK ("customer_address"."country_code" <> 'US' or ("customer_address"."postal_code" ~ '^[0-9]{5}(-[0-9]{4})?$' and "customer_address"."region_code" ~ '^[A-Z]{2}$')),
	CONSTRAINT "customer_address_gstin" CHECK ("customer_address"."gstin" is null or ("customer_address"."country_code" = 'IN' and "customer_address"."gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' and left("customer_address"."gstin", 2) = "customer_address"."region_code"))
);
--> statement-breakpoint
CREATE TABLE "customer_buyer_user" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_group_code_unique" UNIQUE("code"),
	CONSTRAINT "customer_group_code_format" CHECK ("customer_group"."code" ~ '^[a-z][a-z0-9_]{1,62}$')
);
--> statement-breakpoint
CREATE TABLE "customer_customer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"group_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_customer_not_own_parent" CHECK ("customer_customer"."parent_id" <> "customer_customer"."id"),
	CONSTRAINT "customer_customer_name_present" CHECK (length(btrim("customer_customer"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "customer_invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "customer_invitation_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "customer_invitation_email_lowercase" CHECK ("customer_invitation"."email" = lower(btrim("customer_invitation"."email"))),
	CONSTRAINT "customer_invitation_email_shape" CHECK ("customer_invitation"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
	CONSTRAINT "customer_invitation_token_hash_shape" CHECK ("customer_invitation"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "customer_invitation_expiry_after_creation" CHECK ("customer_invitation"."expires_at" > "customer_invitation"."created_at"),
	CONSTRAINT "customer_invitation_accepted_with_user" CHECK (("customer_invitation"."accepted_at" is null) = ("customer_invitation"."accepted_user_id" is null)),
	CONSTRAINT "customer_invitation_single_outcome" CHECK ("customer_invitation"."accepted_at" is null or "customer_invitation"."revoked_at" is null)
);
--> statement-breakpoint
ALTER TABLE "customer_address" ADD CONSTRAINT "customer_address_customer_id_customer_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer_customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_buyer_user" ADD CONSTRAINT "customer_buyer_user_customer_id_customer_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer_customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_customer" ADD CONSTRAINT "customer_customer_parent_id_customer_customer_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."customer_customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_customer" ADD CONSTRAINT "customer_customer_group_id_customer_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."customer_group"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invitation" ADD CONSTRAINT "customer_invitation_customer_id_customer_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer_customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_address_customer_idx" ON "customer_address" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_address_default_billing_uq" ON "customer_address" USING btree ("customer_id") WHERE "customer_address"."is_default_billing";--> statement-breakpoint
CREATE UNIQUE INDEX "customer_address_default_shipping_uq" ON "customer_address" USING btree ("customer_id") WHERE "customer_address"."is_default_shipping";--> statement-breakpoint
CREATE INDEX "customer_buyer_user_customer_idx" ON "customer_buyer_user" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_customer_parent_idx" ON "customer_customer" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "customer_customer_group_idx" ON "customer_customer" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "customer_invitation_customer_idx" ON "customer_invitation" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_invitation_open_uq" ON "customer_invitation" USING btree ("customer_id","email") WHERE "customer_invitation"."accepted_at" is null and "customer_invitation"."revoked_at" is null;