ALTER TABLE "catalog_product" ADD COLUMN "hsn_sac_code" text;--> statement-breakpoint
ALTER TABLE "catalog_product" ADD COLUMN "us_tax_category" text;--> statement-breakpoint
ALTER TABLE "catalog_product" ADD CONSTRAINT "catalog_product_hsn_sac_format" CHECK ("catalog_product"."hsn_sac_code" ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$');--> statement-breakpoint
ALTER TABLE "catalog_product" ADD CONSTRAINT "catalog_product_us_tax_category" CHECK ("catalog_product"."us_tax_category" in ('general', 'exempt'));