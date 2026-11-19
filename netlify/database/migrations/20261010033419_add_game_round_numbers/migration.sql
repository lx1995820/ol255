ALTER TABLE "games" ADD COLUMN "round_number" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "games_date_round_nickname_idx" ON "games" ("date","round_number","nickname");--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_round_number_check" CHECK ("round_number" BETWEEN 1 AND 10000);