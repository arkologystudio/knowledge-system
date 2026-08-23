-- v129 VERIFY — post-deploy (or post-rollback) state check.
--
--   psql "$GBRAIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
--        -f ops/kb-vps/v129-verify.sql --set expect=v129
--
--   --set expect=v129   after deploying   (label predicate active)
--   --set expect=v125   after rollback    (source predicate restored)
--
-- Exits NON-ZERO on the first failed check, so it can gate a deploy script.
-- Every check is phrased so that PASSING means "a guest cannot see more than
-- they were granted, and an internal caller can still see what they always
-- could" — the two ways this can go wrong, in both directions.

\set ON_ERROR_STOP on
\pset pager off

-- Bridge the psql variable into a GUC the DO block below can read.
-- `--set expect=...` defines a psql variable, which is NOT visible inside a
-- server-side DO block; set_config makes it so. Default to v129 when omitted.
\if :{?expect}
\else
  \set expect v129
\endif
SELECT set_config('ks.expect', :'expect', false) AS expecting;

\echo '=============================================='
\echo ' v129 verification'
\echo '=============================================='

SELECT
  (SELECT value FROM config WHERE key = 'version')            AS schema_version,
  (SELECT count(*) FROM sources)                              AS sources,
  (SELECT count(*) FROM pages WHERE deleted_at IS NULL)       AS live_pages,
  (SELECT count(*) FROM spaces)                               AS spaces,
  (SELECT count(*) FROM page_spaces)                          AS labels;

DO $$
DECLARE
  v_expect       TEXT := current_setting('ks.expect', true);
  v_role         BOOLEAN;
  v_unlabelled   INT;
  v_missing_self INT;
  v_label_pols   INT;
  v_meta_pols    INT;
  v_triggers     INT;
  v_orphan_space INT;
BEGIN
  IF v_expect IS NULL OR v_expect = '' THEN v_expect := 'v129'; END IF;
  RAISE NOTICE 'expecting: %', v_expect;

  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gbrain_request') INTO v_role;
  IF NOT v_role THEN
    RAISE EXCEPTION 'FAIL: role gbrain_request is absent. RLS is NOT enforcing anything; every remote read is app-layer only.';
  END IF;
  RAISE NOTICE 'PASS  role gbrain_request exists';

  -- ── structural checks (apply to both states) ──────────────────────────

  -- An unlabelled page is invisible to every scoped caller. After v129 this
  -- must be zero, or part of the corpus silently vanished for remote readers.
  SELECT count(*) INTO v_unlabelled
    FROM pages p
   WHERE NOT EXISTS (SELECT 1 FROM page_spaces ps WHERE ps.page_id = p.id);
  IF v_unlabelled > 0 THEN
    RAISE EXCEPTION 'FAIL: % page(s) carry no access label and are unreachable by any scoped caller. The v129 backfill or its trigger did not cover them.', v_unlabelled;
  END IF;
  RAISE NOTICE 'PASS  every page carries at least one label';

  -- The behaviour-preserving invariant: each page still carries its OWN source
  -- as a label. This is what makes an existing grant resolve to exactly the
  -- pre-v129 result set. If it drifts, internal users start losing content.
  SELECT count(*) INTO v_missing_self
    FROM pages p
   WHERE NOT EXISTS (
     SELECT 1 FROM page_spaces ps
      WHERE ps.page_id = p.id AND ps.space_id = p.source_id);
  IF v_missing_self > 0 THEN
    RAISE EXCEPTION 'FAIL: % page(s) no longer carry their own source as a label. Callers granted that source will not see them.', v_missing_self;
  END IF;
  RAISE NOTICE 'PASS  every page still carries its own source as a label';

  -- Every space id referenced by a label must exist (FK should guarantee it;
  -- assert anyway, because a broken FK here is silent and total).
  SELECT count(*) INTO v_orphan_space
    FROM page_spaces ps
   WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = ps.space_id);
  IF v_orphan_space > 0 THEN
    RAISE EXCEPTION 'FAIL: % label row(s) point at a non-existent space', v_orphan_space;
  END IF;
  RAISE NOTICE 'PASS  no orphaned label rows';

  SELECT count(*) INTO v_triggers
    FROM pg_trigger
   WHERE tgname IN ('ks_page_space_default', 'ks_source_space_mirror');
  IF v_triggers <> 2 THEN
    RAISE EXCEPTION 'FAIL: expected 2 v129 triggers, found %. New pages/sources may be created without a label.', v_triggers;
  END IF;
  RAISE NOTICE 'PASS  both v129 triggers present';

  -- ── predicate shape (differs by expected state) ───────────────────────

  SELECT count(*) INTO v_label_pols
    FROM pg_policies
   WHERE schemaname = current_schema()
     AND policyname = 'ks_source_isolation'
     AND tablename IN ('pages','content_chunks','links','tags','raw_data',
                       'timeline_entries','page_versions','files')
     AND qual LIKE '%page_spaces%';

  SELECT count(*) INTO v_meta_pols
    FROM pg_policies
   WHERE schemaname = current_schema()
     AND (tablename, policyname) IN
         (('page_spaces','ks_space_membership'), ('spaces','ks_space_visibility'));

  IF v_expect = 'v129' THEN
    IF v_label_pols <> 8 THEN
      RAISE EXCEPTION 'FAIL: expected 8 label-scoped policies, found %. Per-artifact access is NOT active.', v_label_pols;
    END IF;
    RAISE NOTICE 'PASS  8 policies enforce per-artifact labels';

    -- Load-bearing: page_spaces and spaces carry RLS too, and an RLS-enabled
    -- table with NO policy denies every row — which would make the EXISTS probe
    -- above find nothing and blank every scoped read while looking healthy.
    IF v_meta_pols <> 2 THEN
      RAISE EXCEPTION 'FAIL: label-table policies missing (found %/2). Scoped reads will return EMPTY.', v_meta_pols;
    END IF;
    RAISE NOTICE 'PASS  label-table policies present (scoped reads can resolve)';

  ELSIF v_expect = 'v125' THEN
    IF v_label_pols <> 0 THEN
      RAISE EXCEPTION 'FAIL: % policy/policies still reference page_spaces. Rollback did not complete.', v_label_pols;
    END IF;
    RAISE NOTICE 'PASS  no policy references page_spaces (v125 predicate restored)';
  ELSE
    RAISE EXCEPTION 'FAIL: unknown --set expect=% (use v129 or v125)', v_expect;
  END IF;

  RAISE NOTICE '----------------------------------------------';
  RAISE NOTICE 'ALL CHECKS PASSED (%).', v_expect;
END $$;

\echo ''
\echo 'Schema state verified. Now confirm BEHAVIOUR from a client:'
\echo '  1. an internal caller still reads what it always could'
\echo '  2. a label-only guest reads ONLY labelled artifacts'
\echo 'Schema checks cannot prove either — they need a real token.'
\echo ''
