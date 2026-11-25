CREATE TABLE "api_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"login" text NOT NULL,
	"token_hash" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "contributions" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"login" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"lemma_id" text NOT NULL,
	"source_sha256" text NOT NULL,
	"result" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"attempt_id" integer,
	"merged_commit" text
);
--> statement-breakpoint
CREATE TABLE "contributor_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"login" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contributors" (
	"login" text PRIMARY KEY NOT NULL,
	"github_id" text,
	"dev" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"blocked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "lemmas" ADD COLUMN "checked_via_pr" integer;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_login_contributors_login_fk" FOREIGN KEY ("login") REFERENCES "public"."contributors"("login") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributor_sessions" ADD CONSTRAINT "contributor_sessions_login_contributors_login_fk" FOREIGN KEY ("login") REFERENCES "public"."contributors"("login") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contributions_pr_head_idx" ON "contributions" USING btree ("pr_number","head_sha");