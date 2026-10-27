CREATE TYPE "public"."platform_scope_type" AS ENUM('global', 'organization', 'website', 'customer_group', 'customer');--> statement-breakpoint
CREATE TYPE "public"."platform_unit_system" AS ENUM('metric', 'imperial');--> statement-breakpoint
CREATE TABLE "platform_config_value" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_type" "platform_scope_type" NOT NULL,
	"scope_id" uuid,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_config_value_scope_key_uq" UNIQUE NULLS NOT DISTINCT("scope_type","scope_id","key"),
	CONSTRAINT "platform_config_value_scope_id_presence" CHECK (("platform_config_value"."scope_type" = 'global') = ("platform_config_value"."scope_id" is null)),
	CONSTRAINT "platform_config_value_key_format" CHECK ("platform_config_value"."key" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);
--> statement-breakpoint
CREATE TABLE "platform_organization" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_website" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"country_code" text NOT NULL,
	"default_currency" text NOT NULL,
	"default_locale" text NOT NULL,
	"time_zone" text NOT NULL,
	"unit_system" "platform_unit_system" DEFAULT 'metric' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_website_code_unique" UNIQUE("code"),
	CONSTRAINT "platform_website_code_format" CHECK ("platform_website"."code" ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
	CONSTRAINT "platform_website_country_format" CHECK ("platform_website"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "platform_website_currency_format" CHECK ("platform_website"."default_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "platform_website" ADD CONSTRAINT "platform_website_organization_id_platform_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."platform_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_config_value_key_idx" ON "platform_config_value" USING btree ("key");--> statement-breakpoint
CREATE INDEX "platform_website_organization_idx" ON "platform_website" USING btree ("organization_id");