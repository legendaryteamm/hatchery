ALTER TABLE "pantry_outflows" ADD COLUMN "note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "pantry_outflows" ADD COLUMN "recorded_by" text DEFAULT '' NOT NULL;