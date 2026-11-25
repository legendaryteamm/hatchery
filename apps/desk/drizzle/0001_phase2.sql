CREATE TABLE "reuses" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"lemma_id" text NOT NULL,
	"reused_lemma_id" text NOT NULL,
	"agent_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lemmas" ADD COLUMN "handoff_note" text;--> statement-breakpoint
ALTER TABLE "lemmas" ADD COLUMN "offered_to" text;--> statement-breakpoint
ALTER TABLE "lemmas" ADD COLUMN "offered_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "reply_to" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "routed_to" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "delivered_in_attempt" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_calls" ADD COLUMN "part" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_calls" ADD COLUMN "served_by_fallback" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reuses" ADD CONSTRAINT "reuses_lemma_id_lemmas_id_fk" FOREIGN KEY ("lemma_id") REFERENCES "public"."lemmas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reuses" ADD CONSTRAINT "reuses_reused_lemma_id_lemmas_id_fk" FOREIGN KEY ("reused_lemma_id") REFERENCES "public"."lemmas"("id") ON DELETE no action ON UPDATE no action;