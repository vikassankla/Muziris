CREATE TYPE "public"."workflow_actor_type" AS ENUM('admin_user', 'buyer_user', 'system');--> statement-breakpoint
CREATE TABLE "workflow_instance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_name" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"current_step" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"step_entered_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_instance_workflow_subject_uq" UNIQUE("workflow_name","subject_id"),
	CONSTRAINT "workflow_instance_workflow_name_format" CHECK ("workflow_instance"."workflow_name" ~ '^[a-z][a-z0-9_]{0,62}$'),
	CONSTRAINT "workflow_instance_current_step_format" CHECK ("workflow_instance"."current_step" ~ '^[a-z][a-z0-9_]{0,62}$'),
	CONSTRAINT "workflow_instance_version_positive" CHECK ("workflow_instance"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "workflow_transition_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"transition" text,
	"from_step" text,
	"to_step" text NOT NULL,
	"actor_type" "workflow_actor_type" NOT NULL,
	"actor_id" uuid,
	"note" text,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workflow_transition_log_instance_sequence_uq" UNIQUE("instance_id","sequence"),
	CONSTRAINT "workflow_transition_log_sequence_positive" CHECK ("workflow_transition_log"."sequence" >= 1),
	CONSTRAINT "workflow_transition_log_start_shape" CHECK (("workflow_transition_log"."sequence" = 1) = ("workflow_transition_log"."transition" is null) and ("workflow_transition_log"."sequence" = 1) = ("workflow_transition_log"."from_step" is null)),
	CONSTRAINT "workflow_transition_log_actor_id_presence" CHECK (("workflow_transition_log"."actor_type" = 'system') = ("workflow_transition_log"."actor_id" is null)),
	CONSTRAINT "workflow_transition_log_note_length" CHECK (char_length("workflow_transition_log"."note") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "workflow_transition_log" ADD CONSTRAINT "workflow_transition_log_instance_id_workflow_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."workflow_instance"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_instance_workflow_step_idx" ON "workflow_instance" USING btree ("workflow_name","current_step");