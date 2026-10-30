CREATE TABLE "tax_exemption" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"state_code" text NOT NULL,
	"certificate_number" text NOT NULL,
	"expires_on" date,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_exemption_customer_state_uq" UNIQUE("customer_id","state_code"),
	CONSTRAINT "tax_exemption_state" CHECK ("tax_exemption"."state_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "tax_exemption_certificate_present" CHECK (length(btrim("tax_exemption"."certificate_number")) between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "tax_gst_rate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_prefix" text NOT NULL,
	"rate" numeric(9, 6) NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_gst_rate_prefix" CHECK ("tax_gst_rate"."code_prefix" ~ '^([0-9]{2}){1,4}$'),
	CONSTRAINT "tax_gst_rate_rate" CHECK ("tax_gst_rate"."rate" >= 0 and "tax_gst_rate"."rate" < 1),
	CONSTRAINT "tax_gst_rate_period" CHECK ("tax_gst_rate"."valid_to" is null or "tax_gst_rate"."valid_to" > "tax_gst_rate"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "tax_registration" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"website_id" uuid NOT NULL,
	"regime" text NOT NULL,
	"region_code" text NOT NULL,
	"number" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_registration_website_region_uq" UNIQUE("website_id","regime","region_code"),
	CONSTRAINT "tax_registration_regime" CHECK ("tax_registration"."regime" in ('gst', 'us_sales_tax')),
	CONSTRAINT "tax_registration_region" CHECK (("tax_registration"."regime" = 'gst' and "tax_registration"."region_code" ~ '^[0-9]{2}$')
        or ("tax_registration"."regime" = 'us_sales_tax' and "tax_registration"."region_code" ~ '^[A-Z]{2}$')),
	CONSTRAINT "tax_registration_gstin" CHECK ("tax_registration"."regime" <> 'gst' or ("tax_registration"."number" ~ '^[0-9]{2}[A-Z0-9]{13}$'
        and left("tax_registration"."number", 2) = "tax_registration"."region_code")),
	CONSTRAINT "tax_registration_number_present" CHECK (length(btrim("tax_registration"."number")) > 0)
);
--> statement-breakpoint
CREATE TABLE "tax_us_rate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_code" text NOT NULL,
	"zip_prefix" text,
	"rate" numeric(9, 6) NOT NULL,
	"shipping_taxable" boolean NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_us_rate_state" CHECK ("tax_us_rate"."state_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "tax_us_rate_zip_prefix" CHECK ("tax_us_rate"."zip_prefix" ~ '^[0-9]{1,5}$'),
	CONSTRAINT "tax_us_rate_rate" CHECK ("tax_us_rate"."rate" >= 0 and "tax_us_rate"."rate" < 1),
	CONSTRAINT "tax_us_rate_period" CHECK ("tax_us_rate"."valid_to" is null or "tax_us_rate"."valid_to" > "tax_us_rate"."valid_from")
);
--> statement-breakpoint
CREATE INDEX "tax_gst_rate_prefix_idx" ON "tax_gst_rate" USING btree ("code_prefix","valid_from");--> statement-breakpoint
CREATE INDEX "tax_us_rate_state_idx" ON "tax_us_rate" USING btree ("state_code","valid_from");