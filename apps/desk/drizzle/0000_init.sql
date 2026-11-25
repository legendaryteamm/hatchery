CREATE TYPE "public"."agent_kind" AS ENUM('internal', 'external');--> statement-breakpoint
CREATE TYPE "public"."attempt_result" AS ENUM('checked', 'failed', 'refuted', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."lemma_status" AS ENUM('open', 'leased', 'checked', 'refuted', 'abandoned', 'recheck');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('question', 'hint', 'note', 'handoff', 'reply');--> statement-breakpoint
CREATE TYPE "public"."outflow_kind" AS ENUM('api_spend', 'topup_transfer', 'other');--> statement-breakpoint
CREATE TYPE "public"."program_status" AS ENUM('active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."statement_status" AS ENUM('proposed', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"species" text NOT NULL,
	"shell_color" text NOT NULL,
	"kind" "agent_kind" DEFAULT 'internal' NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"lemma_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"result" "attempt_result",
	"judge_errors" text,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 6) DEFAULT '0' NOT NULL,
	"notes" text,
	"turns" integer DEFAULT 0 NOT NULL,
	"submitted_source" text
);
--> statement-breakpoint
CREATE TABLE "budget_days" (
	"date" date PRIMARY KEY NOT NULL,
	"global_cap_usd" numeric(14, 6) NOT NULL,
	"per_agent_cap_usd" numeric(14, 6) NOT NULL,
	"spent_usd" numeric(14, 6) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"agent_id" text,
	"lemma_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leases" (
	"lemma_id" text PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_heartbeat" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lemmas" (
	"id" text PRIMARY KEY NOT NULL,
	"status" "lemma_status" DEFAULT 'open' NOT NULL,
	"checked_proof_path" text,
	"checked_at" timestamp with time zone,
	"checked_by_agent" text,
	"checked_source" text,
	"checked_source_sha256" text,
	"checked_commit" text,
	"checked_fingerprint" text,
	"proof_imports" text[] DEFAULT '{}'::text[] NOT NULL,
	"checked_verdict" jsonb
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"from_agent" text NOT NULL,
	"to_agent" text,
	"lemma_id" text,
	"kind" "message_kind" NOT NULL,
	"body" text NOT NULL,
	"short" text NOT NULL,
	"cost_usd" numeric(14, 6) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_id" text NOT NULL,
	"attempt_id" integer,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"tokens_in" integer NOT NULL,
	"tokens_out" integer NOT NULL,
	"cache_read_tokens" integer NOT NULL,
	"cache_write_tokens" integer NOT NULL,
	"cost_usd" numeric(14, 6) NOT NULL,
	"price_as_of" text NOT NULL,
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE "pantry_inflows" (
	"tx_hash" text NOT NULL,
	"chain" text NOT NULL,
	"amount_native" numeric(38, 18) NOT NULL,
	"amount_usd" numeric(14, 6) NOT NULL,
	"usd_rate_source" text NOT NULL,
	"ts" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pantry_outflows" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" "outflow_kind" NOT NULL,
	"amount_usd" numeric(14, 6) NOT NULL,
	"reference" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"status" "program_status" DEFAULT 'active' NOT NULL,
	CONSTRAINT "programs_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "statements" (
	"id" text PRIMARY KEY NOT NULL,
	"program_id" integer NOT NULL,
	"lean_name" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"lean_statement" text NOT NULL,
	"status" "statement_status" DEFAULT 'proposed' NOT NULL,
	"proposed_by" text NOT NULL,
	"approved_by" text,
	"depends_on" text[] DEFAULT '{}'::text[] NOT NULL,
	"requires_mathlib" boolean DEFAULT false NOT NULL,
	"file_sha256" text NOT NULL,
	CONSTRAINT "statements_lean_name_unique" UNIQUE("lean_name")
);
--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_lemma_id_lemmas_id_fk" FOREIGN KEY ("lemma_id") REFERENCES "public"."lemmas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_lemma_id_lemmas_id_fk" FOREIGN KEY ("lemma_id") REFERENCES "public"."lemmas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lemmas" ADD CONSTRAINT "lemmas_id_statements_id_fk" FOREIGN KEY ("id") REFERENCES "public"."statements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_from_agent_agents_id_fk" FOREIGN KEY ("from_agent") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_to_agent_agents_id_fk" FOREIGN KEY ("to_agent") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_lemma_id_lemmas_id_fk" FOREIGN KEY ("lemma_id") REFERENCES "public"."lemmas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statements" ADD CONSTRAINT "statements_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attempts_lemma_idx" ON "attempts" USING btree ("lemma_id");--> statement-breakpoint
CREATE INDEX "attempts_agent_idx" ON "attempts" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "events_lemma_idx" ON "events" USING btree ("lemma_id");--> statement-breakpoint
CREATE INDEX "events_agent_idx" ON "events" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "model_calls_ts_idx" ON "model_calls" USING btree ("ts");--> statement-breakpoint
CREATE UNIQUE INDEX "pantry_inflows_tx_idx" ON "pantry_inflows" USING btree ("chain","tx_hash");