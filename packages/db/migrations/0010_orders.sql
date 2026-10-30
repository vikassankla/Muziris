CREATE SEQUENCE "public"."orders_order_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "orders_order_address" (
	"order_id" uuid NOT NULL,
	"role" text NOT NULL,
	"address_id" uuid NOT NULL,
	"label" text NOT NULL,
	"country_code" text NOT NULL,
	"line1" text NOT NULL,
	"line2" text,
	"city" text NOT NULL,
	"region_code" text NOT NULL,
	"postal_code" text NOT NULL,
	"gstin" text,
	CONSTRAINT "orders_order_address_order_id_role_pk" PRIMARY KEY("order_id","role"),
	CONSTRAINT "orders_order_address_role" CHECK ("orders_order_address"."role" in ('billing', 'shipping')),
	CONSTRAINT "orders_order_address_country" CHECK ("orders_order_address"."country_code" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "orders_order_line" (
	"order_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"product_name" text NOT NULL,
	"unit_code" text NOT NULL,
	"unit_name" text NOT NULL,
	"quantity" numeric(18, 6) NOT NULL,
	"unit_price_minor" bigint NOT NULL,
	"subtotal_minor" bigint NOT NULL,
	"discount_minor" bigint NOT NULL,
	"net_minor" bigint NOT NULL,
	"tax_code" text,
	"price_list_id" uuid NOT NULL,
	CONSTRAINT "orders_order_line_order_id_line_no_pk" PRIMARY KEY("order_id","line_no"),
	CONSTRAINT "orders_order_line_no_positive" CHECK ("orders_order_line"."line_no" > 0),
	CONSTRAINT "orders_order_line_quantity_positive" CHECK ("orders_order_line"."quantity" > 0),
	CONSTRAINT "orders_order_line_amounts" CHECK ("orders_order_line"."unit_price_minor" >= 0 and "orders_order_line"."subtotal_minor" >= 0 and "orders_order_line"."discount_minor" >= 0
        and "orders_order_line"."discount_minor" <= "orders_order_line"."subtotal_minor"),
	CONSTRAINT "orders_order_line_net" CHECK ("orders_order_line"."net_minor" = "orders_order_line"."subtotal_minor" - "orders_order_line"."discount_minor")
);
--> statement-breakpoint
CREATE TABLE "orders_order_tax_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"line_no" integer,
	"name" text NOT NULL,
	"rate" numeric(9, 6) NOT NULL,
	"taxable_minor" bigint NOT NULL,
	"amount_minor" bigint NOT NULL,
	CONSTRAINT "orders_order_tax_line_name_present" CHECK (length(btrim("orders_order_tax_line"."name")) > 0),
	CONSTRAINT "orders_order_tax_line_rate" CHECK ("orders_order_tax_line"."rate" >= 0 and "orders_order_tax_line"."rate" < 1),
	CONSTRAINT "orders_order_tax_line_amounts" CHECK ("orders_order_tax_line"."taxable_minor" >= 0 and "orders_order_tax_line"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "orders_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"website_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"customer_name" text NOT NULL,
	"placed_by" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"step" text DEFAULT 'new' NOT NULL,
	"currency" text NOT NULL,
	"purchase_order_number" text,
	"payment_method" text DEFAULT 'terms' NOT NULL,
	"payment_term_days" integer NOT NULL,
	"due_on" date NOT NULL,
	"shipping_method" text NOT NULL,
	"tax_provider" text NOT NULL,
	"subtotal_minor" bigint NOT NULL,
	"discount_minor" bigint NOT NULL,
	"shipping_minor" bigint NOT NULL,
	"shipping_discount_minor" bigint NOT NULL,
	"tax_minor" bigint NOT NULL,
	"grand_total_minor" bigint NOT NULL,
	"placed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_order_number_unique" UNIQUE("number"),
	CONSTRAINT "orders_order_idempotency_uq" UNIQUE("placed_by","idempotency_key"),
	CONSTRAINT "orders_order_number_format" CHECK ("orders_order"."number" ~ '^[A-Z0-9]{1,10}-[0-9]{6,}$'),
	CONSTRAINT "orders_order_currency_format" CHECK ("orders_order"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "orders_order_step" CHECK ("orders_order"."step" in ('new', 'confirmed', 'processing', 'completed', 'declined')),
	CONSTRAINT "orders_order_payment_method" CHECK ("orders_order"."payment_method" = 'terms'),
	CONSTRAINT "orders_order_payment_term" CHECK ("orders_order"."payment_term_days" between 0 and 365),
	CONSTRAINT "orders_order_request_hash" CHECK ("orders_order"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "orders_order_amounts_not_negative" CHECK ("orders_order"."subtotal_minor" >= 0 and "orders_order"."discount_minor" >= 0 and "orders_order"."shipping_minor" >= 0
        and "orders_order"."shipping_discount_minor" >= 0 and "orders_order"."tax_minor" >= 0 and "orders_order"."grand_total_minor" >= 0),
	CONSTRAINT "orders_order_grand_total" CHECK ("orders_order"."grand_total_minor" = "orders_order"."subtotal_minor" - "orders_order"."discount_minor" + "orders_order"."shipping_minor"
        - "orders_order"."shipping_discount_minor" + "orders_order"."tax_minor")
);
--> statement-breakpoint
ALTER TABLE "orders_order_address" ADD CONSTRAINT "orders_order_address_order_id_orders_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders_order_line" ADD CONSTRAINT "orders_order_line_order_id_orders_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders_order_tax_line" ADD CONSTRAINT "orders_order_tax_line_order_id_orders_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_order_tax_line_order_idx" ON "orders_order_tax_line" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_order_customer_idx" ON "orders_order" USING btree ("customer_id","placed_at","id");--> statement-breakpoint
CREATE INDEX "orders_order_website_idx" ON "orders_order" USING btree ("website_id","placed_at","id");