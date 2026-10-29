CREATE TABLE "pricing_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"price_list_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"target" text NOT NULL,
	"target_id" uuid NOT NULL,
	"priority" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_assignment_list_uq" UNIQUE("website_id","target","target_id","price_list_id"),
	CONSTRAINT "pricing_assignment_priority_uq" UNIQUE("website_id","target","target_id","priority"),
	CONSTRAINT "pricing_assignment_target" CHECK ("pricing_assignment"."target" in ('customer', 'customer_group', 'website')),
	CONSTRAINT "pricing_assignment_website_target" CHECK ("pricing_assignment"."target" <> 'website' or "pricing_assignment"."target_id" = "pricing_assignment"."website_id"),
	CONSTRAINT "pricing_assignment_priority_range" CHECK ("pricing_assignment"."priority" between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "pricing_build_state" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"change_count" bigint DEFAULT 0 NOT NULL,
	"built_change_count" bigint,
	"built_at" timestamp with time zone,
	"built_by" uuid,
	"combined_price_list_count" integer,
	"combined_price_count" integer,
	"build_ms" integer,
	CONSTRAINT "pricing_build_state_one_row" CHECK ("pricing_build_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "pricing_combined_price_list_target" (
	"website_id" uuid NOT NULL,
	"target" text NOT NULL,
	"target_id" uuid NOT NULL,
	"customer_group_id" uuid,
	"combined_price_list_id" uuid NOT NULL,
	CONSTRAINT "pricing_combined_price_list_target_website_id_target_target_id_pk" PRIMARY KEY("website_id","target","target_id"),
	CONSTRAINT "pricing_combined_price_list_target_target" CHECK ("pricing_combined_price_list_target"."target" in ('customer', 'customer_group', 'website'))
);
--> statement-breakpoint
CREATE TABLE "pricing_combined_price_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"price_list_ids" uuid[] NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_combined_price_list_chain_uq" UNIQUE("price_list_ids")
);
--> statement-breakpoint
CREATE TABLE "pricing_combined_price" (
	"combined_price_list_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"unit_code" text NOT NULL,
	"currency" text NOT NULL,
	"min_quantity" numeric(18, 6) NOT NULL,
	"tier_min_quantity" numeric(18, 6) NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"amount_minor" bigint NOT NULL,
	"price_list_id" uuid NOT NULL,
	CONSTRAINT "pricing_combined_price_uq" UNIQUE NULLS NOT DISTINCT("combined_price_list_id","product_id","unit_code","currency","min_quantity","valid_from")
);
--> statement-breakpoint
CREATE TABLE "pricing_price_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"active_from" timestamp with time zone,
	"active_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_price_list_name_present" CHECK (length(btrim("pricing_price_list"."name")) > 0),
	CONSTRAINT "pricing_price_list_currency_format" CHECK ("pricing_price_list"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "pricing_price_list_dates_ordered" CHECK ("pricing_price_list"."active_from" is null or "pricing_price_list"."active_until" is null or "pricing_price_list"."active_until" > "pricing_price_list"."active_from")
);
--> statement-breakpoint
CREATE TABLE "pricing_price" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"price_list_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"unit_code" text NOT NULL,
	"min_quantity" numeric(18, 6) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_price_tier_uq" UNIQUE("price_list_id","product_id","unit_code","min_quantity"),
	CONSTRAINT "pricing_price_min_quantity_positive" CHECK ("pricing_price"."min_quantity" > 0),
	CONSTRAINT "pricing_price_amount_not_negative" CHECK ("pricing_price"."amount_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "pricing_assignment" ADD CONSTRAINT "pricing_assignment_price_list_id_pricing_price_list_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."pricing_price_list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_combined_price_list_target" ADD CONSTRAINT "pricing_combined_price_list_target_combined_price_list_id_pricing_combined_price_list_id_fk" FOREIGN KEY ("combined_price_list_id") REFERENCES "public"."pricing_combined_price_list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_combined_price" ADD CONSTRAINT "pricing_combined_price_combined_price_list_id_pricing_combined_price_list_id_fk" FOREIGN KEY ("combined_price_list_id") REFERENCES "public"."pricing_combined_price_list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_price" ADD CONSTRAINT "pricing_price_price_list_id_pricing_price_list_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."pricing_price_list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pricing_assignment_price_list_idx" ON "pricing_assignment" USING btree ("price_list_id");--> statement-breakpoint
CREATE INDEX "pricing_combined_price_list_target_list_idx" ON "pricing_combined_price_list_target" USING btree ("combined_price_list_id");--> statement-breakpoint
CREATE INDEX "pricing_price_list_name_idx" ON "pricing_price_list" USING btree ("name","id");--> statement-breakpoint
CREATE INDEX "pricing_price_product_idx" ON "pricing_price" USING btree ("product_id");