-- Consolidate the historical alias into the player's canonical nickname.
DELETE FROM "games" AS alias
USING "games" AS canonical
WHERE alias."nickname" = 'vae'
  AND canonical."nickname" = '憶辰'
  AND canonical."date" = alias."date"
  AND canonical."round_number" IS NOT DISTINCT FROM alias."round_number";
UPDATE "games" SET "nickname" = '憶辰' WHERE "nickname" = 'vae';
UPDATE "player_comments" SET "nickname" = '憶辰' WHERE "nickname" = 'vae';
DELETE FROM "player_ratings" AS alias
USING "player_ratings" AS canonical
WHERE alias."nickname" = 'vae'
  AND canonical."nickname" = '憶辰'
  AND canonical."month" = alias."month"
  AND canonical."device_hash" = alias."device_hash";
UPDATE "player_ratings" SET "nickname" = '憶辰' WHERE "nickname" = 'vae';

-- Tournament records are stored as JSONB and are part of the same player history.
UPDATE "tournaments"
SET "mvp" = CASE WHEN "mvp" = 'vae' THEN '憶辰' ELSE "mvp" END,
    "podium" = replace("podium"::text, '"vae"', '"憶辰"')::jsonb,
    "records" = replace("records"::text, '"nickname":"vae"', '"nickname":"憶辰"')::jsonb,
    "bracket" = replace("bracket"::text, '"vae"', '"憶辰"')::jsonb
WHERE "mvp" = 'vae'
   OR "podium"::text LIKE '%"vae"%'
   OR "records"::text LIKE '%"nickname":"vae"%'
   OR "bracket"::text LIKE '%"vae"%';
