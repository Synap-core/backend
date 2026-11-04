-- 0397 — A site member may be a CHART (a cell instance), not only a record.
--
-- 0336 pinned a site member row to `resource_type = 'entity'`. A chart
-- published into a site (services/sharing/site-charts.ts) is a member row with
-- `resource_type = 'cell'` (the cell instance id), `published_collection` =
-- '@charts' (never a profile slug: '@' cannot appear in one), a public id, an
-- optional slug, and the chart payload in `published_properties`
-- ({ v, mode, cellKey, props, data?, capturedAt? }). Every other rule of 0336
-- (audience public, collection + public id present, the revoke trigger, the
-- slug and live-member unique indexes) applies unchanged.
--
-- Widening a CHECK: drop and re-add under the same name, in one transaction.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_shares_site_member_check') THEN
    ALTER TABLE "resource_shares" DROP CONSTRAINT "resource_shares_site_member_check";
  END IF;
  ALTER TABLE "resource_shares" ADD CONSTRAINT "resource_shares_site_member_check"
    CHECK ("site_share_id" IS NULL
           OR ("audience" = 'public'
               AND "resource_type" IN ('entity', 'cell')
               AND "published_collection" IS NOT NULL
               AND "public_id" IS NOT NULL
               AND (("resource_type" = 'cell') = ("published_collection" = '@charts'))));
END $$;
