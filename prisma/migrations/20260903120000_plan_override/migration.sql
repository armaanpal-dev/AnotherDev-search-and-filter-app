-- Operator-set plan override.
--
-- `planName` is recomputed from Shopify billing on every admin visit and by the
-- app_subscriptions/update webhook, so editing it by hand does not survive.
-- `planOverride` is never written by that sync, so it is the supported way to
-- put a shop on a paid tier without a charge.
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "planOverride" TEXT;
