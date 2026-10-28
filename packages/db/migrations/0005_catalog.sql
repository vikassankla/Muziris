CREATE TABLE "catalog_category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_category_code_unique" UNIQUE("code"),
	CONSTRAINT "catalog_category_code_format" CHECK ("catalog_category"."code" ~ '^[a-z][a-z0-9_]{1,62}$'),
	CONSTRAINT "catalog_category_name_present" CHECK (length(btrim("catalog_category"."name")) > 0),
	CONSTRAINT "catalog_category_not_own_parent" CHECK ("catalog_category"."parent_id" <> "catalog_category"."id")
);
--> statement-breakpoint
CREATE TABLE "catalog_product_sold_in" (
	"product_id" uuid NOT NULL,
	"unit_code" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	CONSTRAINT "catalog_product_sold_in_product_id_unit_code_pk" PRIMARY KEY("product_id","unit_code")
);
--> statement-breakpoint
CREATE TABLE "catalog_product_unit" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"precision" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_unit_code_format" CHECK ("catalog_product_unit"."code" ~ '^[a-z][a-z0-9_]{0,31}$'),
	CONSTRAINT "catalog_product_unit_name_present" CHECK (length(btrim("catalog_product_unit"."name")) > 0),
	CONSTRAINT "catalog_product_unit_precision_range" CHECK ("catalog_product_unit"."precision" between 0 and 6)
);
--> statement-breakpoint
CREATE TABLE "catalog_product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'simple' NOT NULL,
	"status" text DEFAULT 'disabled' NOT NULL,
	"category_id" uuid,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_sku_format" CHECK ("catalog_product"."sku" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$'),
	CONSTRAINT "catalog_product_name_present" CHECK (length(btrim("catalog_product"."name")) > 0),
	CONSTRAINT "catalog_product_type" CHECK ("catalog_product"."type" in ('simple')),
	CONSTRAINT "catalog_product_status" CHECK ("catalog_product"."status" in ('enabled', 'disabled')),
	CONSTRAINT "catalog_product_attributes_object" CHECK (jsonb_typeof("catalog_product"."attributes") = 'object')
);
--> statement-breakpoint
ALTER TABLE "catalog_category" ADD CONSTRAINT "catalog_category_parent_id_catalog_category_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."catalog_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_product_sold_in" ADD CONSTRAINT "catalog_product_sold_in_product_id_catalog_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_product_sold_in" ADD CONSTRAINT "catalog_product_sold_in_unit_code_catalog_product_unit_code_fk" FOREIGN KEY ("unit_code") REFERENCES "public"."catalog_product_unit"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_product" ADD CONSTRAINT "catalog_product_category_id_catalog_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."catalog_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_category_parent_idx" ON "catalog_category" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "catalog_product_sold_in_unit_idx" ON "catalog_product_sold_in" USING btree ("unit_code");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_product_sold_in_primary_uq" ON "catalog_product_sold_in" USING btree ("product_id") WHERE "catalog_product_sold_in"."is_primary";--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_product_sku_uq" ON "catalog_product" USING btree (lower("sku"));--> statement-breakpoint
CREATE INDEX "catalog_product_category_idx" ON "catalog_product" USING btree ("category_id");