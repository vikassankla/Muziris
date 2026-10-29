CREATE TABLE "visibility_build_state" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"change_count" bigint DEFAULT 0 NOT NULL,
	"built_change_count" bigint,
	"built_at" timestamp with time zone,
	"built_by" uuid,
	"context_count" integer,
	"visible_product_count" integer,
	"visible_category_count" integer,
	"build_ms" integer,
	CONSTRAINT "visibility_build_state_one_row" CHECK ("visibility_build_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "visibility_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"website_id" uuid,
	"target" text NOT NULL,
	"target_id" uuid,
	"customer_group_id" uuid,
	CONSTRAINT "visibility_context_uq" UNIQUE NULLS NOT DISTINCT("website_id","target","target_id"),
	CONSTRAINT "visibility_context_target" CHECK ("visibility_context"."target" in ('default', 'website', 'customer_group', 'customer')),
	CONSTRAINT "visibility_context_shape" CHECK (case "visibility_context"."target"
        when 'default' then "visibility_context"."website_id" is null and "visibility_context"."target_id" is null
        when 'website' then "visibility_context"."website_id" is not null and "visibility_context"."target_id" = "visibility_context"."website_id"
        else "visibility_context"."website_id" is not null and "visibility_context"."target_id" is not null end)
);
--> statement-breakpoint
CREATE TABLE "visibility_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"website_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"target" text NOT NULL,
	"target_id" uuid NOT NULL,
	"visibility" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visibility_rule_uq" UNIQUE("website_id","subject","subject_id","target","target_id"),
	CONSTRAINT "visibility_rule_subject" CHECK ("visibility_rule"."subject" in ('product', 'category')),
	CONSTRAINT "visibility_rule_target" CHECK ("visibility_rule"."target" in ('customer', 'customer_group', 'website')),
	CONSTRAINT "visibility_rule_website_target" CHECK ("visibility_rule"."target" <> 'website' or "visibility_rule"."target_id" = "visibility_rule"."website_id"),
	CONSTRAINT "visibility_rule_visibility" CHECK ("visibility_rule"."visibility" in ('visible', 'hidden'))
);
--> statement-breakpoint
CREATE TABLE "visibility_visible_category" (
	"context_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	CONSTRAINT "visibility_visible_category_context_id_category_id_pk" PRIMARY KEY("context_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "visibility_visible_product" (
	"context_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	CONSTRAINT "visibility_visible_product_context_id_product_id_pk" PRIMARY KEY("context_id","product_id")
);
--> statement-breakpoint
ALTER TABLE "visibility_visible_category" ADD CONSTRAINT "visibility_visible_category_context_id_visibility_context_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."visibility_context"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_visible_product" ADD CONSTRAINT "visibility_visible_product_context_id_visibility_context_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."visibility_context"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visibility_rule_target_idx" ON "visibility_rule" USING btree ("website_id","target","target_id");--> statement-breakpoint
CREATE INDEX "visibility_rule_subject_idx" ON "visibility_rule" USING btree ("subject","subject_id");