# Schema Packs

A schema pack tells gbrain what shape your brain takes — which directories
exist, what types live in them, how the agent should infer types from
paths, and which link verbs connect what to what. The schema pack is the
**dynamic, always-consulted artifact** every skill reads when filing,
querying, or routing experts. It is the single source of truth for
"what's in your brain."

The v0.39.0.0 wave shipped a full schema-pack cathedral. This doc is the
user-facing reference; for implementation details see
`docs/designs/V038_SCHEMA_PACKS.md` (CEO plan) and the engine layer in
`src/core/schema-pack/`.

## What ships in the box

Two bundled packs:

- **`gbrain-base`** (default) — reproduces pre-v0.38 hardcoded behavior
  byte-for-byte. Existing brains see zero behavior change after upgrade.
  Covers: person, company, deal, meeting, project, place, concept, writing,
  analysis, guide, hardware, architecture, etc. (the original
  `ALL_PAGE_TYPES` list).

- **`gbrain-recommended`** — extends `gbrain-base` with the 13 additional
  directories described in `docs/GBRAIN_RECOMMENDED_SCHEMA.md`: deal,
  meeting, concept, project, source, daily, personal, civic, original,
  place, trip, conversation, writing. If you like the documented
  operational-brain pattern, activate this with:

  ```bash
  gbrain schema use gbrain-recommended
  ```

Plus user-installed packs at `~/.gbrain/schema-packs/<name>/pack.yaml`
that you author with `gbrain schema init` or `gbrain schema fork`.

## CLI surface

Five inspection verbs (shipped in v0.38):

```bash
gbrain schema active     # show resolved pack + which tier set it
gbrain schema list       # list bundled + installed packs
gbrain schema show       # pretty-print the active pack
gbrain schema validate   # validate a manifest's shape
gbrain schema use <pack> # activate a pack (writes ~/.gbrain/config.json)
```

Eight authoring + discovery verbs (shipped in v0.39):

```bash
gbrain schema detect              # propose types matching brain shape
gbrain schema suggest             # LLM-refined proposals on top of detect
gbrain schema review-candidates   # promote / rename / ignore candidates
gbrain schema review-orphans      # surface pages with no matching type
gbrain schema init <name>         # scaffold a stub pack    (experimental)
gbrain schema fork <a> <b>        # copy + rename a pack    (experimental)
gbrain schema edit <name>         # surface the pack path   (experimental)
gbrain schema diff <a> <b>        # set-diff two packs      (experimental)
gbrain schema graph               # ASCII type listing      (experimental)
gbrain schema lint                # flag duplicates + missing prefixes
gbrain schema explain <type>      # plain-English type description (experimental)
gbrain schema downgrade --to <p>  # restore previous pack (recovery)
gbrain schema usage --since 30d   # per-verb invocation counts (D14 telemetry)
```

The verbs marked `experimental` are demand-gated per D14: their usage is
tracked via T15's schema-events audit, and v0.40+ retro decides whether
to deprecate any that stay <5% usage.

## Resolution chain (7 tiers)

When the engine decides "which pack is active for this query?", it walks
this chain top-down. First match wins.

| Tier | Source | Notes |
|------|--------|-------|
| 1 | Per-call `schema_pack` opt | CLI only (`ctx.remote === false`); MCP rejected. |
| 2 | `GBRAIN_SCHEMA_PACK` env | Process-scope override. |
| 3 | Per-source DB config key `schema_pack:source:<id>` | New in v0.38. |
| 4 | Brain-wide DB config key `schema_pack` | |
| 5 | `gbrain.yml schema:` section | Repo-checked. |
| 6 | `~/.gbrain/config.json` `schema_pack` field | What `gbrain schema use` writes. |
| 7 | Default: `gbrain-base` | Always present. |

## How the agent uses the active pack

Every read + write path consults the active pack at runtime:

- **`parseMarkdown`** infers page `type` from path prefixes declared in
  the active pack (`page_types[].path_prefixes`). Without an active pack
  threaded, falls back to the legacy hardcoded `inferType()` so the
  byte-for-byte parity gate stays green.
- **`whoknows` / `find_experts`** scopes candidates to `expert_routing:
  true` types in the active pack.
- **`extract_facts`** runs only on `extractable: true` types.
- **`enrichment-service`** routes person/company enrichment based on the
  pack's primitive declarations.
- **Search hybrid cache** (`knobsHash`) folds in pack name + version
  (v0.39 T21). A cache row written under pack A is unreachable when pack
  B is active. Cross-pack contamination is structurally impossible.

## The magical moment (T2-T4 + T10)

Persona A (Notion refugee) installs gbrain, imports her exports, and the
brain looks unfamiliar — the default `gbrain-base` pack expects
`people/`, `companies/`, etc., but her files live under `Projects/`,
`Reading/`, `Daily Notes/`. The friction signal fires in two places:

1. **Import warn (T7):** the end of `gbrain import` prints
   `[schema] X of Y pages (Z%) have no type matching the active schema
   pack. Run gbrain schema detect to propose a pack matching your
   content shape.`
2. **`gbrain doctor` schema_pack_consistency check** keeps surfacing
   the warning persistently after the import session ends.

She runs the magical moment:

```bash
gbrain schema detect              # heuristic clustering on her actual shape
gbrain schema suggest             # LLM-refined proposals
gbrain schema review-candidates   # human gate on promotion
gbrain schema review-candidates --apply Projects/   # accept
```

The agent (via the new EIIRP skill) automates phases 1-3 of this for any
significant work session. The brain's schema becomes a living artifact
the agent maintains, not a hardcoded ceremony the user authors.

## Authoring your own pack

**Use `fork`, not `init`.** `extends:` is parsed and depth-capped, but the
parent's `page_types` are NOT merged into the child — `resolvePack()` resolves
the child manifest verbatim (`registry.ts`, "Full extends-merging (child-wins)
is the v0.41+ T20 follow-up"; tracked as T20 in `TODOS.md`). So a pack scaffolded
by `gbrain schema init` — which writes `page_types: []` and `extends:
gbrain-base` — activates with **zero declared page types**, not with base's 27.
Every page in the brain becomes an undeclared type the moment you `use` it.

`fork` copies the source manifest wholesale, so the fork really does start with
everything the parent declared:

```bash
gbrain schema fork gbrain-base my-pack   # copies all of base into ~/.gbrain/schema-packs/my-pack/pack.json
gbrain schema add-type my-pack strategy --primitive concept --prefix wiki/strategy/
gbrain schema validate my-pack           # check shape
gbrain schema diff gbrain-base my-pack   # confirm you only added what you meant to
gbrain schema use my-pack                # activate
gbrain schema active                     # confirm
```

Reach for `init` only when you genuinely want to declare a type universe from
scratch — and until T20 lands, expect to restate every type you still want.

A minimal pack:

```yaml
api_version: gbrain-schema-pack-v1
name: my-pack
version: 0.0.1
gbrain_min_version: 0.39.0
extends: gbrain-base   # recorded + depth-checked, but does NOT merge base's
                       # page_types yet (T20) — see the fork note above
description: |
  My personal pack.

page_types:
  - name: project-x
    primitive: entity
    path_prefixes:
      - Projects/
    aliases: []
    extractable: false
    expert_routing: false

  # Add more types here. Each maps a path prefix to a primitive +
  # opt-in flags. See src/core/schema-pack/base/gbrain-recommended.yaml
  # for a worked example.

link_types: []
takes_kinds: [fact, take, bet, hunch]
borrow_from: []
frontmatter_links: []
enrichable_types: []
filing_rules: []
```

## Undeclared types: frontmatter is authoritative, the pack is advisory

**A page may carry a `type` the active pack does not declare, and that is
supported, not a bug.** Undeclared types store, chunk, embed, query and
retrieve normally. Nothing downstream requires a type to be declared.

What the pack buys a type is *inference and opt-in behavior*, not permission
to exist:

| Declared in the pack | Undeclared |
|---|---|
| Path-prefix → type inference on import | `type:` must come from frontmatter |
| `extractable` / `expert_routing` opt-ins available | Both effectively off |
| Alias-closure query expansion | No expansion |
| Appears in `schema_explain_type`, `schema_graph` | `schema explain <type>` exits 1 |
| Counted by `dead_prefixes` when unused | Counted by `undeclared_types` when used |

So the rule is: **frontmatter `type` is authoritative; the pack is advisory,
and exists to infer types you did not write down and to switch on per-type
features.** `gbrain schema explain <type>` exiting 1 means "this type is not
declared", NOT "this type is invalid".

### Seeing the drift

Divergence runs in both directions, and `gbrain schema stats` reports both:

- `dead_prefixes` — declared, but zero matching pages. *The pack claims
  something the corpus doesn't have.*
- `undeclared_types` — in use, but never declared. *The corpus has something
  the pack doesn't claim.*

`schema_review_orphans` answers neither: orphans are pages with **no type at
all**. A page typed `strategy` is confidently typed — it is simply typed
outside the pack — so it never appears there. That gap is why a brain can run
for months at ~29% undeclared with every existing surface reporting clean.

Each `undeclared_types` entry carries a `classification`, because "undeclared"
alone is not actionable when undeclared types are legal:

- `primitive_name` — the type is one of the five primitives (`entity`,
  `media`, `temporal`, `annotation`, `concept`) rather than a page_type that
  *extends* one. A filing mistake in any pack. Always worth fixing.
- `aliased` — some declared type lists it in `aliases[]`, so query expansion
  already reaches it. Low urgency; `schema lint` flags the dangling alias.
- `undeclared` — unknown to the pack in every respect. Either a type worth
  declaring, or a typo. Read `page_count` and `example_slugs` to tell which.

The `schema_undeclared_types` doctor check warns when any `primitive_name`
class is present, or when undeclared pages exceed 5% of typed pages. Below
that it reports `ok` and still returns the full list in `details` — a brain
that has deliberately settled on a couple of local types should not be nagged
forever.

### Choosing to declare, or not

Both are defensible. What is NOT defensible is leaving it undecided — that
ambiguity is what makes an agent stall mid-filing.

**Declare it** when the type needs extractability, expert routing, alias
expansion, or path-prefix inference; or when enough pages carry it that
`schema stats` no longer reads as clean. Cost: `fork` + `add-type` + `use`
(an activation event), plus ongoing pack maintenance, plus — until T20 — a
fork that no longer tracks upstream `gbrain-base` changes.

**Leave it** when the type is a filing convention only and every page already
declares it in frontmatter. Cost: `schema explain` exits 1 for it, and it
shows up in `undeclared_types` forever (as `ok`, under threshold).

**gbrain's default is "leave it".** An undeclared type is not an error, and a
brain is not expected to declare every type it uses. Declaring is an opt-in you
make when you want one of the four behaviors in the table above — not
housekeeping you owe the pack. A brain running at a steady share of undeclared
types is in a supported state, which is why the doctor check thresholds instead
of flagging.

Record your brain's own choice as a page in the brain (a `decision` page is the
natural home) so the next session reads it instead of re-deriving it.

One case is not a policy choice: a type whose `classification` is
`primitive_name` is a filing mistake under either policy. `entity`, `media`,
`temporal`, `annotation` and `concept` are the primitives that page_types
*extend*; a page typed with one directly has no page_type at all. Retype those
pages rather than declaring the primitive.

## Recovery + revert

The single-PR cathedral is hard to revert atomically. Per codex finding
#4 from plan-eng-review, T20 ships `gbrain schema downgrade` to restore
the active-pack config field:

```bash
gbrain schema downgrade --to gbrain-base
# OR auto-detect previous from ~/.gbrain/schema-pack-history.jsonl:
gbrain schema downgrade
```

**Code revert alone is NOT sufficient.** The full revert procedure:

1. `git revert <merge-commit>` — restores the code.
2. `gbrain schema downgrade --to gbrain-base` — restores config.
3. (Optional) `gbrain pages purge-deleted --older-than 0h` — drops
   v0.39-typed pages that no longer have a matching type in the active
   pack.

The cache + eval rows that pack-aware code wrote are isolated by the
`knobsHash` pack-folding (T21) — they become unreachable under the
restored pack so no eviction is needed.

## Distribution

`.gbrain-schema` tarballs ride the same v0.37 skillpack pipeline as
`.gbrain-skillpack` tarballs (T14 artifact abstraction). The
discriminator is `api_version` in the manifest:

- `gbrain-schema-pack-v1` → schemapack
- `gbrain-skillpack-v1` → skillpack

Both install via the same scaffold + copy path; install targets are
`~/.gbrain/schema-packs/<name>/` and `~/.gbrain/skillpacks/<name>/`
respectively.

Publication to the public registries (`garrytan/gbrain-schema-registry`,
`garrytan/gbrain-skillpack-registry`) follows the same publish-as-PR
workflow as v0.37 skillpack publishing.

## What's deferred to v0.40+

- **Per-source pack federation across mounts.** A query crossing multiple
  sources currently rejects with `permission_denied` when those sources
  have divergent active packs (T19 + codex finding #2). The v0.40+ work
  computes a true per-source closure via the existing
  `buildSourceClosureCte` engine surface.
- **`extends` chain semver compatibility checks** between pack versions.
- **`skillpack ↔ schemapack` cross-reference declarations** — a skillpack
  can declare "I work best with these primitives present in your pack."
- **Live schema migration helpers** — when you add a type, auto-suggest
  backfill of existing pages.
- **Authoring vs derivation thesis reframe (D14).** v0.39.0.0 ships the
  full 11-verb cathedral with 6 verbs marked experimental-tier. v0.40+
  retro reads T23 usage telemetry to decide which to deprecate.

See `TODOS.md` v0.40+ section for the full deferred list.
