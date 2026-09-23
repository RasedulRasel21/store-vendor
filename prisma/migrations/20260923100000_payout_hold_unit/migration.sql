-- The hold becomes a number plus a unit, and the minimum gets an explicit on/off.
-- Both are filled in from what each store already had before the old column goes, so a
-- store holding 14 days keeps holding 14 days, and one with a minimum keeps it switched on.
ALTER TABLE "ShopSettings" ADD COLUMN     "payoutHoldUnit" TEXT NOT NULL DEFAULT 'DAYS',
ADD COLUMN     "payoutHoldValue" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "payoutMinimumEnabled" BOOLEAN NOT NULL DEFAULT false;

UPDATE "ShopSettings" SET "payoutHoldValue" = "payoutHoldDays";
UPDATE "ShopSettings" SET "payoutMinimumEnabled" = true WHERE "payoutMinimum" > 0;

ALTER TABLE "ShopSettings" DROP COLUMN "payoutHoldDays";
