CREATE TABLE "search_build_state" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"built_at" timestamp with time zone,
	"built_by" uuid,
	"product_count" integer,
	"build_ms" integer,
	CONSTRAINT "search_build_state_one_row" CHECK ("search_build_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "search_product" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"category_id" uuid,
	"document" "tsvector" NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "search_product_document_idx" ON "search_product" USING gin ("document");--> statement-breakpoint
CREATE INDEX "search_product_sku_trgm_idx" ON "search_product" USING gin (lower("sku") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "search_product_name_trgm_idx" ON "search_product" USING gin (lower("name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "search_product_sku_prefix_idx" ON "search_product" USING btree (lower("sku") text_pattern_ops);