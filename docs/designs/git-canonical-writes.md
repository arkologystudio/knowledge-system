# Design: Git-Anchored Writes — structural enforcement of repo canonicality

**Status:** proposed · **Author:** Claude (session 2026-08-18, with Ross) · **Target:** `arkologystudio/knowledge-system` (gbrain fork)
**Suggested landing path:** `docs/designs/git-canonical-writes.md`

## 0. The invariant

> For any organization brain backed by a remote repo, `origin/main` of the wiki repo is the **single source of truth**. The brain (Postgres index, embeddings, facts) is a **derived, disposable cache of a specific commit**. Every canonical page in the brain must be reachable from `origin/main`.

Today this invariant is prose — encoded in CLAUDE.md instructions, skill text, and operator discipline ("use `commit_page`, not `put_page`"). The 2026-08-18 incident demonstrated that prose does not hold: an agent used `put_page` (as one CLAUDE.md actively instructed), the brain became a second author, and the sync clone wedged for three weeks of silent staleness plus a push-blocking divergence for every other writer.

This design makes the invariant **structural**: after it lands, there is *no reachable code path* on a remote-backed brain that leaves the DB ahead of git, and *no state* the sync clone can reach from which it cannot recover unattended.

## 1. Root-cause taxonomy (why prose failed)

The incident decomposes into three independent structural flaws. Each mechanism below kills one of them.

| # | Flaw | Incident expression |
|---|------|---------------------|
| F1 | **Role conflation.** `/srv/brain-repos/arkology` is simultaneously a read-mirror (sync pulls it) and a write target (`put_page` write-through drops uncommitted files in it; `commit_page` commits in it; root SSHes into it). A directory with two masters can diverge; once diverged, `pull --ff-only` wedges *permanently*. | root committed `put_page`'s untracked droppings → clone 1-ahead/2-behind → every pull and every `commit_page` push failed from 17 Aug 20:22 onward. |
| F2 | **The half-write.** `put_page` writes the DB row + an *uncommitted* file. The DB is momentarily (then indefinitely) authoritative for content that exists nowhere in git history. Whether this is "temporary" depends entirely on whether a human/agent later runs `commit_page` — i.e., on prose. | The two `put_page` pages collided add/add with Ross's hand-authored versions of the same pages — identical bodies, divergent frontmatter (provenance stamps, tag expansion, date quoting). |
| F3 | **Green-while-broken observability.** Health measures *internal* consistency (DB ↔ local clone). It says nothing about *external* consistency (clone ↔ origin; indexed commit ↔ origin head). The `gbrain-pull-watch` guard added one external check (pull success), but ingest-checkpoint lag walked straight past it. | Brain stale at a 28 July commit for ~3 weeks; `get_health` read 100% embed coverage, 0 stale pages, the whole time. |

## 2. Design

### Mechanism A — Split the roles: mirror vs. workspace (kills F1)

**The sync clone becomes a pure mirror.** Sync stops using `git pull --ff-only` and instead does:

```
git fetch origin main
git reset --hard origin/main        # after quarantine, below
```

By construction the mirror **cannot diverge** — divergence stops being a detected-and-alarmed condition and becomes an impossible one. `--ff-only` was the wrong tool: it *protects* local commits, but the mirror must never have local commits worth protecting.

Before each reset, a **quarantine step** preserves anything that shouldn't exist but does:

- Local-only commits (`git log origin/main..HEAD` non-empty) → rescue ref `refs/gbrain/rescue/<utc-ts>` + WARN surfaced in doctor/health. Never silently discarded.
- Dirty/untracked files → moved to `~/.gbrain/quarantine/<source>/<utc-ts>/` (already a concept in the fork: `gbrain quarantine`) + WARN.

Either finding is *evidence of a writer violating the mirror invariant* and is reported as such (named in `sources_status.mirror_violations`), but it no longer *wedges the pipeline*. Sync always converges to origin.

**All writes move out of the mirror** into ephemeral worktrees:

```
git worktree add --detach <tmp> origin/main   # cheap: shares object DB
  → write file → commit → push origin HEAD:main
  → on non-FF race: fetch, rebase, retry (bounded, n=3)
  → on content conflict: structured error + bounded diff (existing commit_page behaviour)
git worktree remove
```

`commit_page` already implements preview/apply, SHA-pinning, protected slugs, repo locking, and `divergenceSafePull` — the change is *where* it operates (worktree, not mirror) and pushing before index update stays as-is. Contention between writes and the 5-minute sync disappears: they no longer share a checkout, only the object store, and a push simply makes the mirror's next fetch pick the commit up. After a successful push, trigger an immediate sync tick so recall reflects the write in seconds, not minutes.

The mirror directory itself gets aggressive hygiene: mode `0700`, and an ops-README breadcrumb *inside* it (`/srv/brain-repos/arkology/DO-NOT-EDIT.md`, git-ignored) saying "this tree is bulldozed every 5 minutes; write via MCP or push to origin". The 09:10 root commit that triggered this incident was a well-intentioned human tidying a dirty tree — make the tree self-describing so the tidy impulse routes correctly.

### Mechanism B — Kill the half-write: `put_page` becomes git-first *by construction* (kills F2)

`put_page` keeps its API (agents and skills continue to call it) but its implementation routes through the **same git pipeline** as `commit_page`:

1. Render canonical markdown (see B3).
2. Worktree → commit (auto message: `brain(put_page): <slug> — via <actor>`) → **push**.
3. Only after push succeeds: update the DB index, stamped `anchored_commit: <sha>`.

`commit_page` remains the *deliberate* surface (preview/apply, SHA pinning, protected slugs enforced for both). `put_page` becomes the *convenient* surface over the same substrate. The CLAUDE.md instruction distinguishing them becomes unnecessary — which is the point. **Prose can still recommend; it no longer has to protect.**

**B1 — Writer modes.** One explicit enum per source replaces today's implicit behaviour soup:

| `writer.mode` | Truth | `put_page` behaviour | Use |
|---|---|---|---|
| `git-first` (**default when the source has a remote**) | `origin/main` | commit+push then index; push failure = write failure | Org brains (kb-vps, octopi) |
| `local-tree` | The working tree; a human commits | write file into tree, index; **never commits** | Ross's personal brain (the refresh daemon imports the tree; git is the human's act) |
| `db-only` | The DB, explicitly ephemeral | index only; no file | Scratch/test brains, no repo configured |

Mode is derived, not chosen freely: a source with `remote_url`/tracked origin **must** be `git-first` — configuring `db-only` on a remote-backed source is a refused config write. The dangerous middle ground the incident exploited — *DB + uncommitted file inside a pulled clone* — corresponds to no mode and ceases to be a reachable state. `src/core/write-through.ts` (the uncommitted-file drop) is **deleted** for `git-first` sources; its stated purpose ("a committable .md artifact") is subsumed by actually committing it.

**B2 — Push failure = write failure (fail-loud), with a visible ledger.** In `git-first` mode, if the push cannot complete after the bounded rebase-retry, the `put_page`/`commit_page` call **returns an error** — the agent is told, this turn, that the write did not happen, with the git error attached (already redacted by `redactGitError`). No silent DB-only fallback: a fallback would recreate F2 with extra steps.

Rejected alternative — a durable outbox (queue unpushed commits, retry in background): superficially kinder, but it reintroduces "the brain knows things git doesn't" with a timer attached, and its failure mode (outbox silently deep) is exactly F3 again. If offline-writing ever becomes a real need, an outbox can be added *behind* the health accounting in Mechanism C, where depth > 0 degrades the score. Not now.

(Upstream 0.46 has "Same-session push-failure notice" — a re-announcing surfacing loop for background push failures. Cherry-pick it; it complements fail-loud for anything that still pushes in the background, e.g. autopilot.)

**B3 — Canonical serialization (kills the conflict *content*).** Today's add/add conflict was pure noise: same bodies, different frontmatter, because the brain rewrites what it ingests (tag expansion, ISO-datetime quoting) and *injects provenance* (`ingested_via`, `ingested_at`, `source_kind`) into the file. Two rules:

1. **Provenance lives in the DB, not the file.** The committed markdown carries only author-meaningful frontmatter. Machine provenance (`ingested_via`, `anchored_commit`, timestamps of ingestion) is DB metadata, queryable via MCP, never serialized into the repo. Git already *is* the provenance layer for files — committer, message, history. Duplicating it into frontmatter created the diff that created the conflict.
2. **Round-trip stability:** `parse(serialize(parse(md))) ≡ parse(md)` and, for already-canonical files, `serialize(parse(md)) ≡ md` byte-identical. One serializer (`serializePageToMarkdown`) used by sync, lint --fix, and both write ops. A hand-authored page and a machine-written page of the same content converge to the same bytes → git merges become trivial or empty.

### Mechanism C — Observability keyed to the invariant (kills F3)

Health currently answers "is the DB consistent with the local clone?" It must answer "**is the brain a fresh cache of `origin/main`?**" — three commits and their ages, end-to-end:

```
origin_head       (from last successful fetch)   + last_successful_fetch_at
mirror_head       (the clone)                     — equal to origin_head by construction post-A
indexed_commit    (the ingest checkpoint)         + lag = origin_head..indexed_commit
```

- `get_health` and `sources_status` expose all three. **`brain_score` is capped (e.g. ≤ 40) while `indexed_commit ≠ origin_head` beyond a grace window, or while `last_successful_fetch_at` exceeds a ceiling.** A green screen becomes *impossible* during either failure — this single rule would have caught both the 3-week staleness and the divergence on day one, from any MCP client, without SSH.
- `gbrain-pull-watch` evolves into `gbrain-freshness-watch`: alarms on **indexed-commit lag** (the true end-to-end signal) rather than pull success (a mid-pipeline proxy). Pull success stays as corroborating data. Same detection-only philosophy, same state file, plus the quarantine/rescue events from Mechanism A.
- Cherry-pick upstream's staleness work (see §3): the wall-clock staleness ceiling and "honest staleness in `gbrain status`" implement part of this.

### What stays deliberately unchanged

- **Humans and bots push straight to `origin/main`.** Git is the concurrency arbiter; occasional non-FF rejections answered by `git pull --rebase` are normal multi-writer traffic, not a defect. No branch protection or PR gate is imposed by this design (an org can add one; the system must not require it).
- **`commit_page`'s preview/apply + SHA-pinning contract** — unchanged, now shared by `put_page`.
- **Protected slugs** (`north-star`, `voice/*`) — unchanged, now *also* guarding `put_page` (a strict improvement: they were bypassable via the half-write).
- **Ross's personal brain** — declared `local-tree`; its behaviour today (daemon imports the working tree, human commits) was always correct, but by accident. Now it's correct by declaration.

## 3. Upstream integration (0.43.0.0 → 0.46.19.0)

The fork point is upstream `0.43.0.0` (2026-08-08); the fork carries 18 local patches (`0.43.0.1–18`), upstream has shipped **44 releases** since. A wholesale merge is a project of its own (personas, plugin lanes, embedding-provider migration, dream-cycle rework) and should **not** gate this design. Recommendation: **cherry-pick by area now, schedule the wholesale-merge decision separately.**

Cherry-picks that directly serve this design (Tier 1):

| Upstream item | Serves |
|---|---|
| Sync no longer silently drops git `T`/`U` statuses | Mechanism A correctness |
| A wedged sync can no longer read as "in progress" forever (`--break-lock` remedy in doctor) | F3 |
| Content-relative staleness wall-clock ceiling (`GBRAIN_STALENESS_CEILING_HOURS`) | Mechanism C |
| Honest staleness numbers in `gbrain status` | Mechanism C |
| A dead autopilot can no longer report healthy (heartbeat-based `--status`, real exit codes) | F3 |
| Same-session push-failure notice | B2 |
| Lint visibility on writes (`put_page` returns top findings) | B3 adjacency |
| A failed first sync no longer kills the MCP server | robustness |
| `serve --source-guard` (fail-closed write routing on ambiguous source) | same fail-closed philosophy |

Tier 2 (valuable, independent): structural write accounting for subagent jobs; divergent-queue alarms; `doctor --remediate`; per-job lock leases.

**Fork hygiene decisions (needed regardless):**

1. **Disable `self-upgrade` on fork installs.** `binary-self-update.ts` fetches releases from `garrytan/gbrain` — on the VPS, running `gbrain self-upgrade` (which the CLI nags about on every invocation: `UPGRADE_AVAILABLE 0.43.0.18 0.46.19.0`) would **replace the fork with upstream**, silently reverting every fork patch. Point the check at the fork's own repo or hard-disable the channel (`mode=off` + remove the nag). This is a live footgun today.
2. Add `upstream` as a git remote of the fork; institute a periodic (e.g. monthly) changelog review to keep the cherry-pick option cheap.
3. Version scheme: continue `0.43.0.x` fork-local, or re-baseline after a future merge — decide at merge time.

## 4. Migration plan (incident-shaped ordering: observability first)

| Phase | Content | Size | Risk |
|---|---|---|---|
| **0 — today** | `gbrain-freshness-watch`: extend the existing guard to alarm on indexed-commit lag vs `origin_head`. Pure ops script + timer; no engine change. Disable the self-upgrade footgun on kb-vps. | S | none |
| **1** | Mechanism A: sync's git step → fetch + quarantine + reset; mirror dir hygiene. Contained in the sync git module (`git-remote.ts` + sync step). | M | low — behaviour only changes in states that are today's failure states |
| **2** | Mechanism B: worktree write path (refactor `git-page-write.ts` to operate in ephemeral worktrees); route `put_page` through it; `writer.mode` enum + derivation rule; delete `write-through.ts` for `git-first`; B3 canonical serializer + provenance-out-of-frontmatter. | L | main risk = serializer round-trip regressions; gate with a corpus round-trip test over the whole arkology wiki |
| **3** | Mechanism C in-engine: three-commit model in `get_health`/`sources_status`, score cap. Retire the phase-0 script's overlap. | M | low |
| Interleaved | Tier-1 cherry-picks, each with its upstream tests. | M | per-pick |

Phase 0 alone would have converted this incident from "found by a user report weeks later" to "alarmed within 25 minutes, twice over."

## 5. Test invariants (the pins that keep this true)

1. **No-bypass pin:** on a `git-first` source, any code path that results in a DB page row whose content hash is not reachable from a commit on `origin/main` fails the suite (walk pages → `anchored_commit` set and ancestor of origin/main).
2. **Mirror-convergence pin:** seed the mirror with (a) a local commit, (b) dirty files, (c) a diverged history → after one sync tick, mirror ≡ origin/main, rescue ref/quarantine populated, health shows the violation.
3. **Round-trip pin:** for every `.md` in the test corpus (import the real wiki as a fixture), `serialize(parse(f)) == f` byte-identical once canonicalized, and `put_page(content)` followed by `git show` returns the canonical bytes with **no provenance keys**.
4. **Fail-loud pin:** push refused (simulated non-FF beyond retry budget / auth failure) → `put_page` returns error, **DB row unchanged**, no file left anywhere.
5. **Green-impossible pin:** `indexed_commit ≠ origin_head` past grace → `brain_score ≤ cap`, regardless of every internal metric being perfect.

## 6. Decisions taken in this design (each reversible, flagged per triage protocol)

| Decision | Alternative rejected | Why |
|---|---|---|
| `put_page` keeps its name/API, becomes git-first internally | Deprecate `put_page`, force `commit_page` everywhere | Existing skills/agents keep working; enforcement shouldn't depend on every caller migrating — that's prose again |
| Fail-loud on push failure | Durable outbox | Outbox = F2 with a timer; revisit behind health accounting if offline writes become real |
| `reset --hard` mirror + quarantine | Keep `--ff-only` + better alarms | Alarms detect; reset *prevents*. Unattended convergence is the point |
| Provenance in DB, not frontmatter | Frontmatter stamps (status quo) | The stamps *were* the conflict; git is already the file-level provenance layer |
| Cherry-pick upstream, defer wholesale merge | Merge 0.46 now | 44 releases of unrelated surface; don't couple the safety fix to a mega-merge |
| Modes derived from remote presence, not free config | Free choice of mode | A remote-backed source configured `db-only` is the incident again by config |
