-- v129 RE-APPLY — put the per-artifact label predicate back after a rollback.
--
-- WHY THIS EXISTS
--   `v129-rollback.sql` restores the v125 source predicate but leaves
--   `config.version` at 129, deliberately, so a later `gbrain migrate` cannot
--   silently undo the rollback. The cost of that choice is that migrate also
--   will not roll you FORWARD again — the runner only applies migrations with
--   `version > current`. This script is the way back.
--
--   It is the policy half of migration 129 only. `spaces`, `page_spaces`, the
--   backfill and the triggers survive a rollback untouched, so there is no
--   second backfill and no window where a page is unlabelled.
--
--   psql "$GBRAIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f v129-reapply.sql
--
--   Then: psql … -f v129-verify.sql --set expect=v129
--
-- SAFE TO RE-RUN. Every statement is DROP + CREATE.

\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gbrain_request') THEN
    RAISE EXCEPTION 'v129-reapply: role gbrain_request is absent — v125 was never provisioned. Run `gbrain migrate` first.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema = current_schema() AND table_name = 'page_spaces') THEN
    RAISE EXCEPTION 'v129-reapply: page_spaces is missing. This node never reached migration 129 — run `gbrain migrate` rather than this script.';
  END IF;

  GRANT SELECT ON page_spaces, spaces TO gbrain_request;

  -- Load-bearing: both label tables carry RLS, and an RLS-enabled table with no
  -- policy denies every row — the EXISTS probes below would then find nothing
  -- and blank every scoped read while the deployment looked healthy.
  -- Scoped, not permissive: a caller sees only the label rows for spaces it
  -- holds, so a guest cannot enumerate the org's other audiences.
  DROP POLICY IF EXISTS ks_space_membership ON page_spaces;
  CREATE POLICY ks_space_membership ON page_spaces FOR SELECT TO gbrain_request
    USING (space_id = ANY(NULLIF(current_setting('app.allowed_sources', true), '')::text[]));

  DROP POLICY IF EXISTS ks_space_visibility ON spaces;
  CREATE POLICY ks_space_visibility ON spaces FOR SELECT TO gbrain_request
    USING (id = ANY(NULLIF(current_setting('app.allowed_sources', true), '')::text[]));

  DROP POLICY IF EXISTS ks_source_isolation ON pages;
  CREATE POLICY ks_source_isolation ON pages FOR SELECT TO gbrain_request
    USING (EXISTS (
      SELECT 1 FROM page_spaces ps
       WHERE ps.page_id = pages.id
         AND ps.space_id = ANY(NULLIF(current_setting('app.allowed_sources', true), '')::text[])
    ));

  DROP POLICY IF EXISTS ks_source_isolation ON content_chunks;
  CREATE POLICY ks_source_isolation ON content_chunks FOR SELECT TO gbrain_request
    USING (
      EXISTS (SELECT 1 FROM page_spaces ps WHERE ps.page_id = content_chunks.page_id
                AND ps.space_id = ANY(NULLIF(current_setting('app.allowed_sources', true), '')::text[]))
      OR EXISTS (SELECT 1 FROM artifacts a WHERE a.id = content_chunks.artifact_id
                AND a.source_id = ANY(NULLIF(current_setting('app.allowed_sources', true), '')::text[]))
    );

  -- Both endpoints AND the origin must be visible: an edge into an unreadable
  -- artifact does not exist for this caller (silent drop, enforced in the DB).
  DROP POLICY IF EXISTS ks_source_isolation ON links;
  CREATE POLICY ks_source_isolation ON links FOR SELECT TO gbrain_request
    USING (
      EXISTS (SELECT 1 FROM page_spaces ps WHERE ps.page_id = links.from_page_id
                AND ps.space_id = ANY(NULLIF(current_setting('app.allowed_sources', true), '')::text[]))
      AND EXISTS (SELECT 1 FROM page_spaces ps WHERE ps.page_id = links.to_page_id
                AND ps.space_id = ANY(NULLIF(current_setting('app.allowed_sources', true), '')::text[]))
      AND (links.origin_page_id IS NULL OR EXISTS (
            SELECT 1 FROM page_spaces ps WHERE ps.page_id = links.origin_page_id
              AND ps.space_id = ANY(NULLIF(current_setting('app.allowed_sources', true), '')::text[])))
    );

  DROP POLICY IF EXISTS ks_source_isolation ON tags;
  CREATE POLICY ks_source_isolation ON tags FOR SELECT TO gbrain_request
    USING (EXISTS (SELECT 1 FROM page_spaces ps WHERE ps.page_id = tags.page_id
              AND ps.space_id = ANY(NULLIF(current_setting('app.allowed_sources', true), '')::text[])));

  DROP POLICY IF EXISTS ks_source_isolation ON raw_data;
  CREATE POLICY ks_source_isolation ON raw_data FOR SELECT TO gbrain_request
    USING (EXISTS (SELECT 1 FROM page_spaces ps WHERE ps.page_id = raw_data.page_id
              AND ps.space_id = ANY(NULLIF(current_setting('app.allowed_sources', true), '')::text[])));

  DROP POLICY IF EXISTS ks_source_isolation ON timeline_entries;
  CREATE POLICY ks_source_isolation ON timeline_entries FOR SELECT TO gbrain_request
    USING (EXISTS (SELECT 1 FROM page_spaces ps WHERE ps.page_id = timeline_entries.page_id
              AND ps.space_id = ANY(NULLIF(current_setting('app.allowed_sources', true), '')::text[])));

  DROP POLICY IF EXISTS ks_source_isolation ON page_versions;
  CREATE POLICY ks_source_isolation ON page_versions FOR SELECT TO gbrain_request
    USING (EXISTS (SELECT 1 FROM page_spaces ps WHERE ps.page_id = page_versions.page_id
              AND ps.space_id = ANY(NULLIF(current_setting('app.allowed_sources', true), '')::text[])));

  -- Page-linked files follow their page's labels; page-less files keep source
  -- scoping. OR'd, so this can only widen relative to v125, never narrow.
  DROP POLICY IF EXISTS ks_source_isolation ON files;
  CREATE POLICY ks_source_isolation ON files FOR SELECT TO gbrain_request
    USING (
      EXISTS (SELECT 1 FROM page_spaces ps WHERE ps.page_id = files.page_id
                AND ps.space_id = ANY(NULLIF(current_setting('app.allowed_sources', true), '')::text[]))
      OR files.source_id = ANY(NULLIF(current_setting('app.allowed_sources', true), '')::text[])
    );

  RAISE NOTICE 'v129-reapply: per-artifact label policies restored.';
END $$;

COMMIT;

\echo ''
\echo 'Re-applied. Verify with:'
\echo '  psql "$GBRAIN_DATABASE_URL" -f ops/kb-vps/v129-verify.sql --set expect=v129'
\echo ''
