# Source Mirror

Deterministic code that mirrors an organisation's existing knowledge — Google
Drive, Notion, an Obsidian vault — into a git repository of markdown, which the
Knowledge System then indexes through its existing git sync. No SaaS connector
lives in the engine; the repository is the canonical corpus and the brain is an
index over it.

This directory is the **harness** — the source-agnostic spine. The Google Drive,
Notion, and Obsidian legs plug into it and land in their own tasks.

Design: `arkology-wiki/projects/habitats/wiki/syntheses/source-mirror-pattern.md`.
Decisions: `arkology-architecture-and-development-tooling/projects/arkology-habitat/DECISIONS.md` (D-SM-1..4).

## Load-bearing invariants

- **Writes only under `sources/`.** Enforced in code (`paths.ts:assertUnderSources`),
  not documentation. A mirror defect can corrupt mirrored material — reproducible
  from upstream — but can never reach authored `wiki/` content.
- **Identity is the upstream's own stable id, minted as a RID** (`ridForExternal`),
  never a path. A rename upstream is a MOVE, not a delete-and-recreate, so inbound
  references survive.
- **Idempotent: seed and sync are one code path.** Running twice with no upstream
  change produces a byte-identical tree and no commit. `mirrored_at` is excluded
  from change detection so it never forces a rewrite.
- **Mass-deletion guard.** A run whose desired set is empty, or that would forget
  more than a threshold fraction of a leg's manifest, aborts that leg without
  writing — the canonical auth-glitch-wipes-everything failure cannot happen.
- **Per-leg isolation.** One upstream outage fails its leg and no other; each leg
  commits independently.
- **Dry-run by default.** Application is explicit (`--apply`).

## Layout

| File | Role |
|---|---|
| `types.ts` | `SourceObject` + the `MirrorSource` leg contract (legs yield the FULL current set each run). |
| `paths.ts` | Path derivation + the `sources/` allowlist guard. |
| `frontmatter.ts` | Deterministic provenance frontmatter; RID + link-back via the shipped RID layer. |
| `state.ts` | `.mirror/state.json` — per-leg cursor + RID-keyed manifest. |
| `reconcile.ts` | Diff (New/Update/Move/Forget/Unchanged) + the mass-deletion guard + apply. |
| `git.ts` | Per-leg commits (nothing staged → no commit). |
| `run.ts` | Orchestration with per-leg isolation. |
| `notify.ts` | Failure-notification seam (concrete channel wired by the runner task). |
| `registry.ts` / `legs/` | Leg registration; legs self-register here. |
| `cli.ts` | `bun run mirror run --repo <brain-repo> --config <config.json> [--dry-run\|--apply] [--leg <id>]`. |

## Run

```
bun run mirror run --repo /path/to/brain-repo --config mirror.config.json          # dry-run (default)
bun run mirror run --repo /path/to/brain-repo --config mirror.config.json --apply  # write + commit per leg
```

The config lists the legs to run; each is built from the registry by its `kind`.
With no legs registered this is a well-behaved no-op — the harness is exercised by
`test/mirror-*.test.ts` against an in-memory fake leg.
