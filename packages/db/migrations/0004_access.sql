CREATE TYPE "public"."access_level" AS ENUM('own_records', 'my_customer', 'my_customer_and_subsidiaries');--> statement-breakpoint
CREATE TABLE "access_admin_role_permission" (
	"role_id" uuid NOT NULL,
	"permission" text NOT NULL,
	CONSTRAINT "access_admin_role_permission_pk" PRIMARY KEY("role_id","permission"),
	CONSTRAINT "access_admin_role_permission_format" CHECK ("access_admin_role_permission"."permission" ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "access_admin_role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"is_built_in" boolean DEFAULT false NOT NULL,
	"grants_all_permissions" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_admin_role_code_unique" UNIQUE("code"),
	CONSTRAINT "access_admin_role_code_format" CHECK ("access_admin_role"."code" ~ '^[a-z][a-z0-9_]{1,62}$'),
	CONSTRAINT "access_admin_role_grants_all_built_in" CHECK (not "access_admin_role"."grants_all_permissions" or "access_admin_role"."is_built_in")
);
--> statement-breakpoint
CREATE TABLE "access_admin_user_role" (
	"admin_user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_admin_user_role_pk" PRIMARY KEY("admin_user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "access_buyer_role_permission" (
	"role_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"access_level" "access_level" NOT NULL,
	CONSTRAINT "access_buyer_role_permission_pk" PRIMARY KEY("role_id","permission"),
	CONSTRAINT "access_buyer_role_permission_format" CHECK ("access_buyer_role_permission"."permission" ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "access_buyer_role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"is_built_in" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_buyer_role_code_unique" UNIQUE("code"),
	CONSTRAINT "access_buyer_role_code_format" CHECK ("access_buyer_role"."code" ~ '^[a-z][a-z0-9_]{1,62}$')
);
--> statement-breakpoint
CREATE TABLE "access_buyer_user_role" (
	"buyer_user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_buyer_user_role_pk" PRIMARY KEY("buyer_user_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "access_admin_role_permission" ADD CONSTRAINT "access_admin_role_permission_role_id_access_admin_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."access_admin_role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_admin_user_role" ADD CONSTRAINT "access_admin_user_role_role_id_access_admin_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."access_admin_role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_buyer_role_permission" ADD CONSTRAINT "access_buyer_role_permission_role_id_access_buyer_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."access_buyer_role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_buyer_user_role" ADD CONSTRAINT "access_buyer_user_role_role_id_access_buyer_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."access_buyer_role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_admin_user_role_role_idx" ON "access_admin_user_role" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "access_buyer_user_role_role_idx" ON "access_buyer_user_role" USING btree ("role_id");