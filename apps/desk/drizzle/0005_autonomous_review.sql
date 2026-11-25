ALTER TYPE "public"."definition_status" ADD VALUE 'rejected';--> statement-breakpoint
ALTER TYPE "public"."definition_status" ADD VALUE 'blocked';--> statement-breakpoint
CREATE TABLE "review_flags" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"issue_number" integer NOT NULL,
	"login" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"reason" text NOT NULL,
	"round_id" integer,
	CONSTRAINT "review_flags_issue_number_unique" UNIQUE("issue_number")
);
--> statement-breakpoint
CREATE TABLE "review_rounds" (
	"id" serial PRIMARY KEY NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"target_sha256" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"trigger" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"adversary_checks" integer DEFAULT 0 NOT NULL,
	"adversary_done" boolean DEFAULT false NOT NULL,
	"adversary_spent_usd" numeric(14, 6) DEFAULT '0' NOT NULL,
	"adversary_agent" text,
	"adversary_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "review_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"round_id" integer NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"actor" text NOT NULL,
	"model" text,
	"verdict" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"reasoning" text DEFAULT '' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_usd" numeric(14, 6) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "definitions" ADD COLUMN "reviewed_via" text;--> statement-breakpoint
ALTER TABLE "definitions" ADD COLUMN "adversary_goals" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "definitions" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
ALTER TABLE "statements" ADD COLUMN "sanity_for" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "statements" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_steps" ADD CONSTRAINT "review_steps_round_id_review_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."review_rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_rounds_target_idx" ON "review_rounds" USING btree ("target_kind","target_id");--> statement-breakpoint
CREATE INDEX "review_steps_round_idx" ON "review_steps" USING btree ("round_id");