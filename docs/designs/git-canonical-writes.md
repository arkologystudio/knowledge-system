# Design: Git-Anchored Writes — structural enforcement of repo canonicality

**Status:** in progress — Phase 0, 0b, 2a and 1 landed · **Author:** Claude (session 2026-08-18, with Ross) · **Target:** `arkologystudio/knowledge-system` (gbrain fork)
**Suggested landing path:** `docs/designs/git-canonical-writes.md`

## 0. The invariant

> For any organization brain backed by a remote repo, `origin/main` of the wiki repo is the **single source of truth**. The brain (Postgres index, embeddings, facts) is a **derived, disposable cache of a specific commit**. Every canonical page in the brain must be reachable from `origin/main`.

Today this invariant is prose — encoded in CLAUDE.md instructions, skill text, and operator discipline ("use `commit_page`, not `put_page`"). The 2026-08-18 incident demonstrated that prose does not hold: an agent used `put_page` (as one CLAUDE.md actively instructed), the brain became a second author, and the sync clone wedged for three weeks of silent staleness plus a push-blocking divergence for every other writer.

This design makes the invariant **structural**: after it lands, there is *no reachable code path* on a remote-backed brain that leaves the DB ahead of git, and *no state* the sync clone can reach from which it cannot recover unattended.

**Status against that bar, as of v0.43.0.22** — stated plainly, because a design doc that overstates its own completion is how the next incident gets missed:

- ✅ No `put_page` write leaves the DB ahead of git on a managed source, and no write-through path leaves an *uncommitted file* in a managed tree (the refusal is central and fails closed).
- ⚠️ `gbrain rid backfill` writes RID stamps directly via `writeBrainPage`, bypassing write-through entirely. It leaves a dropping that the next converge quarantines and reverts — so the stamps do not stick on a managed source. Tracked with Phase 2b.
- ⚠️ Two paths are still DB-only on a managed source: `submit_ingest` and sandbox subagents (Phase 2b). They cannot wedge a mirror, but they are not anchored.
- ⚠️ The mirror recovers unattended from divergence, dirt, and local commits — but **not** from a detached HEAD, a missing `origin/<branch>`, or an untracked path `git clean -fd` refuses to remove (a nested git repository, or one the process cannot write). All three are refused or reported rather than wedging silently, but none self-heals, so the "no state" claim is not yet literal.
- ⚠️ **Ignored files are outside the preserve/report machinery.** `.gitignore`d paths appear in neither `status -uall` nor `clean -fd`, so when an upstream commit starts tracking a path a mirror currently ignores, `reset --hard` overwrites the local content unscanned, unquarantined and unreported. Phase 1b.

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

`commit_page` already implements preview/apply, SHA-pinning, protected slugs, repo locking, and `divergenceSafePull` — the change is *where* it operates (worktree, not mirror) and pushing before index update stays as-is. **Checkout** contention with the 5-minute sync disappears: writes no longer touch the mirror's working tree, and a push simply makes the mirror's next fetch pick the commit up. After a successful push, trigger an immediate sync tick so recall reflects the write in seconds, not minutes.

**Worktrees do not eliminate git-level contention, and the design must not pretend they do.** `git worktree add` writes into the mirror's `.git` (`.git/worktrees/<id>`, ref locks), and obtaining an up-to-date `origin/main` to branch from requires a fetch into that same `.git` — i.e. the shared ref and `FETCH_HEAD` surface that caused the July 2026 incident. Three requirements follow, and they are part of Phase 2's contract rather than incidental detail:

1. **Never fetch into `FETCH_HEAD` from a write path.** Use an explicit private refspec (`+refs/heads/main:refs/gbrain/write/<id>`) so write fetches and the sync pull can never nominate competing merge candidates.
2. **Writes continue to take the existing cross-process repo lock** (`src/core/repo-lock.ts`) around the fetch + worktree add/remove, exactly as page writes do today (30s wait, then fail loudly). The lock's scope shrinks — it no longer has to cover the commit itself — but it does not go away.
3. **Prefer a separate git dir over a worktree if measurement shows ref-lock contention** at the write rates we actually see. A second bare clone costs disk and a fetch; it shares nothing. Decide with a measurement in Phase 2, not by assertion here.

**Status:** 2a shipped WITHOUT worktree isolation, deliberately. The existing cross-process repo lock already serialises writers against the 5-minute sync, and this requirement asks for a measurement rather than an assertion — so the measurement is owed before the isolation lands, not after.

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
| `git-first` (**forced for machine-managed sources** — see derivation below) | `origin/main` | commit+push then index; push failure = write failure | Org brains (kb-vps, octopi) |
| `local-tree` (default when not machine-managed) | The working tree; a human commits | write file into tree, index; **never commits** | Ross's personal brain (the refresh daemon imports the tree; git is the human's act) |
| `db-only` | The DB, explicitly ephemeral | index only; no file | Scratch/test brains, no repo configured |

**Mode derivation, and the one legitimate opt-out.** Remote presence alone cannot be the discriminator: Ross's personal wiki has an origin *and* is correctly `local-tree` (a human commits from Obsidian; no daemon should). The discriminating property is not "has a remote" but **"is this working tree machine-managed?"** — i.e. does something automatically pull and reset it?

So the rule is: a source is `git-first` **iff it is a machine-managed clone**, recorded as an explicit `source.managed: true` set at registration time (any source gbrain itself clones/pulls, which is every org brain). Given `managed: true`, `git-first` is forced — `db-only` and `local-tree` are refused config writes. Given `managed: false` (a path the operator points at and tends by hand), `local-tree` is the default and `git-first` is available opt-in. `db-only` requires no repo at all.

The dangerous middle ground the incident exploited — *DB + uncommitted file inside a machine-pulled clone* — corresponds to no mode and ceases to be a reachable state. `src/core/write-through.ts` (the uncommitted-file drop) is **deleted** for `git-first` sources; its stated purpose ("a committable .md artifact") is subsumed by actually committing it. It is retained, unchanged and correct, for `local-tree`.

**B1a — Bulk writes commit in batches, not per page.** Routing `put_page` through commit+push makes every caller pay a network round trip, and the bulk callers (`submit_ingest`, `ingest-bulk`, `brainstorm/lsd --save`, dream-cycle synthesis) write tens to hundreds of pages per operation. N pages must not become N commits and N pushes contending with each other and with every other writer — with fail-loud semantics and a bounded rebase retry, that turns ordinary contention into partial-import failure.

Bulk paths therefore open **one** worktree, write all pages, make **one** commit, and push once; the DB index updates for all pages after that push lands. Partial failure is then all-or-nothing per batch, which is both easier to reason about and closer to what a human contributor does. Single-page `put_page` keeps the simple path. The per-write latency budget (worktree add + commit + push, realistically 1–3s against GitHub) is acceptable for interactive writes and is the explicit price of the invariant; if it ever isn't, the answer is batching or a coalescing window, never a silent DB-only fallback.

**B2 — Push failure = write failure (fail-loud), with a visible ledger.** In `git-first` mode, if the push cannot complete after the bounded rebase-retry, the `put_page`/`commit_page` call **returns an error** — the agent is told, this turn, that the write did not happen, with the git error attached (already redacted by `redactGitError`). No silent DB-only fallback: a fallback would recreate F2 with extra steps.

Rejected alternative — a durable outbox (queue unpushed commits, retry in background): superficially kinder, but it reintroduces "the brain knows things git doesn't" with a timer attached, and its failure mode (outbox silently deep) is exactly F3 again. If offline-writing ever becomes a real need, an outbox can be added *behind* the health accounting in Mechanism C, where depth > 0 degrades the score. Not now.

(Upstream 0.46 has "Same-session push-failure notice" — a re-announcing surfacing loop for background push failures. Cherry-pick it; it complements fail-loud for anything that still pushes in the background, e.g. autopilot.)

**B3 — Canonical serialization (kills the conflict *content*).** Today's add/add conflict was pure noise: same bodies, different frontmatter, because the brain rewrites what it ingests (tag expansion, ISO-datetime quoting) and *injects provenance* (`ingested_via`, `ingested_at`, `source_kind`) into the file. Two rules:

1. **Provenance lives in the DB, not the file.** The committed markdown carries only author-meaningful frontmatter. Machine provenance (`ingested_via`, `anchored_commit`, timestamps of ingestion) is DB metadata, queryable via MCP, never serialized into the repo. Git already *is* the provenance layer for files — committer, message, history. Duplicating it into frontmatter created the diff that created the conflict.
2. **Round-trip stability:** `parse(serialize(parse(md))) ≡ parse(md)` and, for already-canonical files, `serialize(parse(md)) ≡ md` byte-identical. One serializer (`serializePageToMarkdown`) used by sync, lint --fix, and both write ops. A hand-authored page and a machine-written page of the same content converge to the same bytes → git merges become trivial or empty.

Migration cost is small but not zero: only 3 of 456 committed files in the arkology wiki currently carry these keys, and nothing reads them back out of frontmatter (they are passed *into* `putPage` as options, never parsed from disk). But `ingested_via`/`source_kind` are **not** in `HASH_EPHEMERAL_FRONTMATTER_KEYS` (`src/core/content-hash.ts`), so removing them changes those pages' content hash and triggers a re-chunk and re-embed. Trivial at 3 files; worth knowing before running it on a brain where a bulk import stamped thousands. Either add the keys to the ephemeral set in the same change, or accept the one-off re-embed.

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
- **Ross's personal brain** — `managed: false` → `local-tree`; its behaviour today (daemon imports the working tree, human commits) was always correct, but by accident. Now it's correct by declaration. Note this brain *has* a git origin, which is exactly why the mode discriminator is machine-management rather than remote presence (§B1).

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
| **0 — today** | Extend the existing guard to alarm on indexed-commit lag vs `origin_head`, degrade (never `ok`) when it cannot measure, and never let a failed probe reset the staleness clock. Pure ops script + timer; no engine change. Document the self-upgrade footgun and disable its two gated channels on kb-vps. **Done** (v0.43.0.19). | S | none |
| **0b — done** | Close the self-upgrade footgun structurally: build identity as a compile-time constant (`src/core/distribution.ts`), foreign releases refused on every apply path, passive checks report fork status. Config could not do this — `self_upgrade.mode` is not on the path the dangerous commands take. **Done** (v0.43.0.20). | S | none — inert on upstream builds |
| **2a — done** | Mechanism B core: `writer.mode` derived from a `writer.managed_sources` declaration; `put_page` routed through the git-first commit+push path on managed sources; write-through refused centrally for managed sources; provenance kept out of the committed bytes as a consequence of committing the caller's content. **Done** (v0.43.0.21). | M | landed |
| **2b — open** | Anchor the two remaining database-only paths on managed sources: `submit_ingest` (ingest-capture minion → `importFromContent` with no git) and sandbox subagents (`viaSubagent` without `allowedSlugPrefixes`). Neither leaves a dropping, so neither can wedge a mirror — but neither is reachable from `origin/main` either, so §0's invariant is not yet literally true. Also owed: §B1a bulk batching. | M | — |
| **1 — done** | Mechanism A: sync's git step → fetch + quarantine + reset for machine-managed sources; violations reported as `mirror_violation` warnings. Ordering hazard resolved by landing 2a first. **Done** (v0.43.0.22). Mirror dir hygiene (0700 + `DO-NOT-EDIT.md` breadcrumb) still outstanding. | M | landed |
| **2** | Mechanism B: worktree write path (refactor `git-page-write.ts` onto ephemeral worktrees + private refspec); route `put_page` through it; bulk batching (§B1a); `writer.mode` + `managed` derivation; delete `write-through.ts` for `git-first`; B3 canonical serializer + provenance-out-of-frontmatter. | L | main risk = serializer round-trip regressions; gate with a corpus round-trip test over the whole arkology wiki |
| **3** | Mechanism C in-engine: three-commit model in `get_health`/`sources_status`, score cap. Retire the phase-0 script's overlap. | M | low |
| Interleaved | Tier-1 cherry-picks, each with its upstream tests. | M | per-pick |

**Ordering hazard — RESOLVED by shipping 2a first.** The original plan ran Phase 1 before Phase 2 and the review caught that this destroys data; the resolution was simply to invert the order, which costs nothing and removes the hazard at its root rather than mitigating it. The reasoning, kept because it is the reason the order is what it is:

**Ordering hazard — Phase 1 without part of Phase 2 destroys data.** Today `put_page` drops an *uncommitted* file into the machine-managed clone and it survives there until someone commits it (which is how the incident's two pages reached git at all). Phase 1's `reset --hard` bulldozes exactly that file within 5 minutes — quarantined rather than lost, but no longer landing in git by the accidental route people currently rely on. Write-through droppings are a **normal, everyday state**, not a failure state, so Phase 1 is not the low-risk change it first appears. Therefore Phase 1 must ship with write-through disabled for machine-managed sources (making `put_page` DB-only and *loudly* so, until Phase 2 makes it git-first), or Phases 1 and 2 must merge. Shipping Phase 1 alone is not an option.

Phase 0 alone would have converted this incident from "found by a user report weeks later" to "alarmed within ~30–45 minutes, twice over" (three consecutive 15-minute observations against a 1500s grace).

## 5. Test invariants (the pins that keep this true)

1. **No-bypass pin:** on a `git-first` source, any code path that results in a DB page row whose content hash is not reachable from a commit on `origin/main` fails the suite (walk pages → `anchored_commit` set and ancestor of origin/main).
2. **Mirror-convergence pin:** seed the mirror with (a) a local commit, (b) dirty files, (c) a diverged history → after one sync tick, mirror ≡ origin/main, rescue ref/quarantine populated, health shows the violation.
3. **Round-trip pin:** for every `.md` in the test corpus (import the real wiki as a fixture), `serialize(parse(f)) == f` byte-identical once canonicalized, and `put_page(content)` followed by `git show` returns the canonical bytes with **no provenance keys**.
4. **Fail-loud pin:** push refused (simulated non-FF beyond retry budget / auth failure) → `put_page` returns error, **DB row unchanged**, no file left anywhere.
5. **Green-impossible pin:** `indexed_commit ≠ origin_head` past grace → `brain_score ≤ cap`, regardless of every internal metric being perfect.
6. **Cannot-measure-is-not-green pin:** every freshness surface (the Phase 0 guard, and `get_health`/`sources_status` from Phase 3) must report a distinct *unverified* state — never its healthy value — when the measurement itself fails: DB unreadable, remote unreachable, branch/source misconfigured. A monitor that cannot measure and says "fine" is the original bug wearing a different hat; the first cut of the Phase 0 guard shipped exactly that and was caught in review.
7. **Probe-flap pin:** an intermittently-failing freshness probe must not extend time-to-alarm without bound. Alternating success/failure runs against a genuinely stale index must still alarm — i.e. a failed measurement never resets the staleness clock. (Regression-tested; this was the review's blocking finding B1.)
8. **Git-ahead-is-benign pin:** a push that succeeds followed by a failed DB index update leaves git ahead of the brain. This is the *safe* direction — the next sync tick reconciles it — and must be asserted as such: no retry storm, no rollback of the pushed commit, and the page appears in the index within one tick. Only DB-ahead-of-git (pin 1) is a violation.

## 6. Decisions taken in this design (each reversible, flagged per triage protocol)

| Decision | Alternative rejected | Why |
|---|---|---|
| `put_page` keeps its name/API, becomes git-first internally | Deprecate `put_page`, force `commit_page` everywhere | Existing skills/agents keep working; enforcement shouldn't depend on every caller migrating — that's prose again |
| Fail-loud on push failure | Durable outbox | Outbox = F2 with a timer; revisit behind health accounting if offline writes become real |
| `reset --hard` mirror + quarantine | Keep `--ff-only` + better alarms | Alarms detect; reset *prevents*. Unattended convergence is the point |
| Provenance in DB, not frontmatter | Frontmatter stamps (status quo) | The stamps *were* the conflict; git is already the file-level provenance layer |
| Cherry-pick upstream, defer wholesale merge | Merge 0.46 now | 44 releases of unrelated surface; don't couple the safety fix to a mega-merge |
| Modes derived from **machine-management** (`managed`), not free config | Derive from remote presence; or free choice of mode | A managed source configured `db-only` is the incident again by config. Remote presence is the wrong discriminator — the personal brain has an origin and is legitimately hand-committed |
| Bulk writes = one commit + one push per batch | One commit per page | N pushes contending under fail-loud semantics turns ordinary contention into partial-import failure |
| Phase 1 ships with write-through disabled (or merges into Phase 2) | Ship Phase 1 standalone as planned | `reset --hard` would bulldoze `put_page` droppings that are a normal state today, not a failure state |
