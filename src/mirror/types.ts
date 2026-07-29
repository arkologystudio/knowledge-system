/**
 * Source Mirror — shared harness types.
 *
 * The Source Mirror pulls an organisation's knowledge out of external SaaS tools
 * (Google Drive, Notion, Obsidian) into a git repository of markdown that the
 * Knowledge System indexes through its existing git sync. This module defines the
 * source-agnostic contract every leg plugs into; the harness owns ALL writing, so
 * a leg only has to yield normalised objects.
 *
 * Design: arkology-wiki projects/habitats/wiki/syntheses/source-mirror-pattern.md
 * Decisions: arkology-architecture-and-development-tooling projects/arkology-habitat/DECISIONS.md (D-SM-1..4)
 */
import type { RidNamespace } from '../core/rid';

/**
 * A normalised object emitted by a source leg. The leg has already done any
 * source-specific fetching and conversion; the harness derives identity, path,
 * provenance frontmatter, and the git write from this.
 */
export interface SourceObject {
  /**
   * The upstream system's OWN stable identifier (Drive file id, Notion page id).
   * This is what identity is keyed on — a rename upstream must NOT change it, so
   * inbound references survive (requirement 9). Never a path or a title.
   */
  upstreamId: string;
  /** Display title; used to derive a human-readable path segment. */
  title: string;
  /** The markdown body to write. The leg has already converted to markdown. */
  body: string;
  /** ISO-8601 upstream last-modified time. Recorded as provenance; also the cursor high-water mark. */
  upstreamMtime: string;
  /**
   * SHA-256 (hex) of the ORIGINAL upstream blob, when `body` is a DERIVATION of
   * it (text extracted from a binary). Omitted when `body` IS the original (a
   * Google Doc or Notion page exported directly to markdown). This is what lets
   * a better extractor later change the derived text while the source's recorded
   * identity holds steady (requirement 11).
   */
  originalSha256?: string;
  /** Identity + version of the extractor that produced `body`, when derived. e.g. "pdf-text@1". */
  extractor?: string;
  /** Optional extra provenance the leg wants recorded verbatim (flat string map). */
  extra?: Record<string, string>;
}

/**
 * A source leg. Legs are the ONLY source-specific code; everything else is the
 * shared harness.
 *
 * **Contract:** `list` MUST yield the FULL current desired set of objects on
 * every run — not just those changed since `cursor`. The harness diffs the
 * result against its manifest to detect New / Update / Move / Forget, and the
 * mass-deletion guard depends on a full enumeration to tell "the account is
 * empty because a token glitched" from "these items were really removed". The
 * `cursor` is advisory (a leg may use it to sort or to skip re-fetching bodies);
 * correctness never depends on it.
 */
export interface MirrorSource {
  /** Stable leg id. Also the `sources/<id>/` subtree name. */
  readonly id: string;
  /** RID namespace this leg mints identity under (e.g. 'google_drive.file', 'notion.page'). */
  readonly namespace: RidNamespace;
  /** Enumerate the full current desired set. `cursor` is the leg's persisted checkpoint or null. */
  list(cursor: string | null): AsyncIterable<SourceObject>;
}

/** How a desired object relates to what the manifest already knows. */
export type ChangeKind = 'new' | 'update' | 'move' | 'forget' | 'unchanged';

/** A single planned change for a leg, before it is applied. */
export interface PlannedChange {
  kind: ChangeKind;
  refId: string;
  /** Destination path (repo-relative) for new/update/move/unchanged; the removed path for forget. */
  path: string;
  /** Prior path, present only for a move. */
  fromPath?: string;
}

/** The reconciliation plan for one leg. Pure data — computed before any write. */
export interface LegPlan {
  legId: string;
  changes: PlannedChange[];
  /** New cursor high-water mark (max upstreamMtime seen), or null when the leg was empty. */
  nextCursor: string | null;
  /** True when the plan has no new/update/move/forget — a genuine no-op run. */
  unchanged: boolean;
}

/** Receives operational failures so they surface where an operator will see them. */
export interface Notifier {
  failure(legId: string, err: Error): void;
}

/** Harness run configuration. */
export interface MirrorConfig {
  /** Absolute path to the brain (corpus) git repository the mirror writes into. */
  repoRoot: string;
  /** The source legs to run, in order. */
  legs: MirrorSource[];
  /** Failure sink. Defaults to a console notifier. */
  notifier?: Notifier;
  /**
   * Mass-deletion guard threshold: abort a leg if the fraction of its manifest
   * that would be forgotten exceeds this. Default 0.5. An empty desired set over
   * a non-empty manifest always aborts, regardless of threshold.
   */
  massDeletionThreshold?: number;
}

/** Options for a single run. */
export interface RunOptions {
  /** When true (the default), compute and report the plan but write nothing. */
  dryRun: boolean;
  /** Optional leg-id filter; when set, only that leg runs. */
  legFilter?: string;
}

/** Per-leg outcome of a run. */
export interface LegReport {
  legId: string;
  ok: boolean;
  /** Present on success. */
  plan?: LegPlan;
  /** Present on failure (including a tripped mass-deletion guard). */
  error?: string;
  /** True when the guard aborted this leg specifically. */
  guardTripped?: boolean;
}

/** The full result of a run. */
export interface RunReport {
  dryRun: boolean;
  legs: LegReport[];
  /** True when every leg succeeded (no failures, no tripped guards). */
  ok: boolean;
}
