ALTER TABLE duel_rooms ADD COLUMN sheets TEXT CHECK (length(sheets) = 405);
--> statement-breakpoint
ALTER TABLE duel_rooms ADD COLUMN guest_level INTEGER CHECK (guest_level BETWEEN 0 AND 4);
