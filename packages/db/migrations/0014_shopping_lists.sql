CREATE TABLE "shopping_list_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"product_id" uuid NOT NULL,
	"unit_code" text NOT NULL,
	"quantity" numeric(18, 6) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shopping_list_line_product_unit" UNIQUE("list_id","product_id","unit_code"),
	CONSTRAINT "shopping_list_line_quantity_positive" CHECK ("shopping_list_line"."quantity" > 0),
	CONSTRAINT "shopping_list_line_note_length" CHECK (char_length("shopping_list_line"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "shopping_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"website_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shopping_list_name_length" CHECK (char_length("shopping_list"."name") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "shopping_list_line" ADD CONSTRAINT "shopping_list_line_list_id_shopping_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."shopping_list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shopping_list_line_list_idx" ON "shopping_list_line" USING btree ("list_id","position");--> statement-breakpoint
CREATE INDEX "shopping_list_customer_idx" ON "shopping_list" USING btree ("customer_id","website_id");--> statement-breakpoint
CREATE INDEX "shopping_list_owner_idx" ON "shopping_list" USING btree ("owner_id");