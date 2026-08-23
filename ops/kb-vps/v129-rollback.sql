-- v129 ROLLBACK — restore the v125 source-level RLS predicate.
--
-- WHEN TO RUN THIS
--   Migration 129 rewrote the `ks_source_isolation` policies from
--   "row's source is in the caller's grant" to "artifact carries a label the
--   caller holds". If that misbehaves in production, this puts the v125
--   predicate back.
--
--   The failure mode to expect is FAIL-CLOSED, not a leak: a wrong predicate
--   matches nothing, so the brain reads EMPTY for remote callers while the CLI
--   (BYPASSRLS) still works. An empty brain is the symptom; this is the cure.
--
-- WHAT IT DOES NOT DO
--   * Does NOT drop `spaces` / `page_spaces`. The label data is expensive to
--     rebuild and harmless to keep — nothing reads it once the policies below
--     are back on `source_id`. Re-applying forward is then just re-running the
--     v129 policy DDL, with no second backfill.
--   * Does NOT drop the two triggers. They only keep `page_spaces` populated
--     for pages created while rolled back, which is exactly what you want if
--     you intend to roll forward again.
--   * Does NOT change `config.version`. It stays 129, and the runner only
--     applies migrations with `version > current`
--     (src/core/migrate.ts: `pending = sorted.filter(m => m.version > current)`),
--     so a later `gbrain migrate` will NOT silently undo this rollback.
--
-- CODE VS SCHEMA
--   This is a SCHEMA-only rollback and is safe with the v129 CODE still
--   deployed: `sourceScopeOpts` stands down when RLS engages, and the restored
--   policy filters on the same GUC. A normal principal granted a source id
--   keeps working; a label-only guest correctly sees nothing, because the
--   feature is off. If you also need the code back, revert the commit and
--   redeploy — but try this first, it is faster and reversible.
--
--   psql "$GBRAIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f v129-rollback.sql

\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gbrain_request') THEN
    RAISE NOTICE 'v129-rollback: role gbrain_request absent — nothing to roll back (RLS was never provisioned).';
    RETURN;
  END IF;

  -- ── direct source_id column ────────────────────────────────────────────
  DROP POLICY IF EXISTS ks_source_isolation ON pages;
  CREATE POLICY ks_source_isolation ON pages FOR SELECT TO gbrain_request
    USING (source_id = ANY(NULLIF(current_setting('app.allowed_sources', true), '')::text[]));

  DROP POLICY IF EXISTS ks_source_isolation ON files;
  CREATE POLICY ks_source_isolation ON files FOR SELECT TO gbrain_request
    USING (source_id = ANY(NULLIF(current_setting('app.allowed_sources', true), '')::text[]));

  -- ── transitive via parent page (v125 shape) ────────────────────────────
  DROP POLICY IF EXISTS ks_source_isolation ON content_chunks;
  CREATE POLICY ks_source_isolation ON content_chunks FOR SELECT TO gbrain_request
    USING (
      EXISTS (SELECT 1 FROM pages p WHERE p.id = content_chunks.page_id
                AND p.source_id = ANY(NULLIF(current_setting('app.allowed_sources', true), '')::text[]))
      OR EXISTS (SELECT 1 FROM artifacts a WHERE a.id = content_chunks.artifact_id
                AND a.source_id = ANY(NULLIF(current_setting('app.allowed_sources', true), '')::text[]))
    );

  -- NOTE: v125 scoped only the NEAR endpoint here. v129 tightened it to require
  -- both endpoints + origin. Restoring v125 therefore RE-WIDENS link reads to
  -- the near-endpoint rule — correct for a rollback (it is what shipped), but
  -- be aware you are giving that back.
  DROP POLICY IF EXISTS ks_source_isolation ON links;
  CREATE POLICY ks_source_isolation ON links FOR SELECT TO gbrain_request
    USING (EXISTS (SELECT 1 FROM pages p WHERE p.id = links.from_page_id
                AND p.source_id = ANY(NULLIF(current_setting('app.allowed_sources', true), '')::text[])));

  DROP POLICY IF EXISTS ks_source_isolation ON tags;
  CREATE POLICY ks_source_isolation ON tags FOR SELECT TO gbrain_request
    USING (EXISTS (SELECT 1 FROM pages p WHERE p.id = tags.page_id
                AND p.source_id = ANY(NULLIF(current_setting('app.allowed_sources', true), '')::text[])));

  DROP POLICY IF EXISTS ks_source_isolation ON raw_data;
  CREATE POLICY ks_source_isolation ON raw_data FOR SELECT TO gbrain_request
    USING (EXISTS (SELECT 1 FROM pages p WHERE p.id = raw_data.page_id
                AND p.source_id = ANY(NULLIF(current_setting('app.allowed_sources', true), '')::text[])));

  DROP POLICY IF EXISTS ks_source_isolation ON timeline_entries;
  CREATE POLICY ks_source_isolation ON timeline_entries FOR SELECT TO gbrain_request
    USING (EXISTS (SELECT 1 FROM pages p WHERE p.id = timeline_entries.page_id
                AND p.source_id = ANY(NULLIF(current_setting('app.allowed_sources', true), '')::text[])));

  DROP POLICY IF EXISTS ks_source_isolation ON page_versions;
  CREATE POLICY ks_source_isolation ON page_versions FOR SELECT TO gbrain_request
    USING (EXISTS (SELECT 1 FROM pages p WHERE p.id = page_versions.page_id
                AND p.source_id = ANY(NULLIF(current_setting('app.allowed_sources', true), '')::text[])));

  RAISE NOTICE 'v129-rollback: v125 source-level policies restored on 8 tables.';
END $$;

-- Post-condition: no restored policy may still mention page_spaces.
DO $$
DECLARE stale INT;
BEGIN
  SELECT count(*) INTO stale FROM pg_policies
   WHERE schemaname = current_schema()
     AND policyname = 'ks_source_isolation'
     AND qual LIKE '%page_spaces%';
  IF stale > 0 THEN
    RAISE EXCEPTION 'v129-rollback FAILED: % policy/policies still reference page_spaces', stale;
  END IF;
END $$;

COMMIT;

\echo ''
\echo 'Rollback complete. Verify with:'
\echo '  psql "$GBRAIN_DATABASE_URL" -f ops/kb-vps/v129-verify.sql --set expect=v125'
\echo ''
