CREATE TYPE "public"."definition_status" AS ENUM('draft', 'approved', 'changes_requested');--> statement-breakpoint
CREATE TYPE "public"."review_decision" AS ENUM('approve', 'request_changes', 'reject', 'comment');--> statement-breakpoint
CREATE TYPE "public"."reviewer_role" AS ENUM('advisor', 'maintainer');--> statement-breakpoint
CREATE TABLE "definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"path" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"source" text NOT NULL,
	"source_sha256" text NOT NULL,
	"imports" text[] DEFAULT '{}'::text[] NOT NULL,
	"requires_mathlib" boolean DEFAULT false NOT NULL,
	"status" "definition_status" DEFAULT 'draft' NOT NULL,
	"reviewed_sha256" text,
	"reviewed_by" integer,
	"reviewed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviewer_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"reviewer_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviewers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" "reviewer_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"invite_token_hash" text,
	"invite_expires_at" timestamp with time zone,
	"invite_used_at" timestamp with time zone,
	CONSTRAINT "reviewers_invite_token_hash_unique" UNIQUE("invite_token_hash")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"target_sha256" text NOT NULL,
	"reviewer_id" integer NOT NULL,
	"decision" "review_decision" NOT NULL,
	"comment" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "split_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_id" text NOT NULL,
	"lemma_id" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"handled_at" timestamp with time zone,
	"proposals" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "id_prefix" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "sort" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "statements" ADD COLUMN "source" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "statements" ADD COLUMN "origin" text DEFAULT 'repo' NOT NULL;--> statement-breakpoint
ALTER TABLE "statements" ADD COLUMN "def_imports" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "statements" ADD COLUMN "check" jsonb;--> statement-breakpoint
ALTER TABLE "statements" ADD COLUMN "rationale" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "statements" ADD COLUMN "reject_reason" text;--> statement-breakpoint
ALTER TABLE "statements" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "statements" ADD COLUMN "proposed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "statements" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviewer_sessions" ADD CONSTRAINT "reviewer_sessions_reviewer_id_reviewers_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."reviewers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewer_id_reviewers_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."reviewers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reviews_target_idx" ON "reviews" USING btree ("target_kind","target_id");