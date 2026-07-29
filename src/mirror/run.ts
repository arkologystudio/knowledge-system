/**
 * The run orchestrator: drive each leg through reconcile + apply + commit, with
 * per-leg isolation.
 *
 * Per-leg isolation is a hard requirement: one upstream outage (or a tripped
 * mass-deletion guard) must not block the other legs or leave a partially-written
 * tree. Each leg runs in its own try/catch and its own commit, so a failure is
 * contained, reported to the notifier, and the run continues.
 */
import { commitPaths } from './git';
import { ConsoleNotifier } from './notify';
import { applyLeg, planLeg, summarisePlan } from './reconcile';
import {
  legState,
  loadState,
  saveState,
  stateFileRepoRelative,
  type MirrorState,
} from './state';
import type {
  LegReport,
  MirrorConfig,
  MirrorSource,
  RunOptions,
  RunReport,
  SourceObject,
} from './types';
import { MassDeletionGuardError } from './reconcile';

/** Drain a leg's async enumeration into an array (the full desired set). */
async function collect(leg: MirrorSource, cursor: string | null): Promise<SourceObject[]> {
  const out: SourceObject[] = [];
  for await (const obj of leg.list(cursor)) out.push(obj);
  return out;
}

/** Run one leg end-to-end. Never throws — returns a report and, on failure, notifies. */
async function runLeg(
  config: MirrorConfig,
  state: MirrorState,
  leg: MirrorSource,
  opts: RunOptions,
  mirroredAt: string,
): Promise<LegReport> {
  const notifier = config.notifier ?? new ConsoleNotifier();
  try {
    const prior = legState(state, leg.id);
    const desired = await collect(leg, prior.cursor);
    const plan = planLeg(leg, prior, desired, config.massDeletionThreshold);

    if (opts.dryRun || plan.unchanged) {
      // Dry-run: report the plan, write nothing. Unchanged: genuinely nothing to do.
      return { legId: leg.id, ok: true, plan };
    }

    const applied = applyLeg(config.repoRoot, leg, prior, desired, plan, mirroredAt);
    // Commit the leg's touched paths together with the state file, so state and
    // content advance atomically per leg.
    state.legs[leg.id] = applied.legState;
    saveState(config.repoRoot, state);
    commitPaths(
      config.repoRoot,
      [...applied.touchedPaths, stateFileRepoRelative()],
      `mirror(${leg.id}): ${summarisePlan(plan)}`,
    );
    return { legId: leg.id, ok: true, plan };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    notifier.failure(leg.id, error);
    return {
      legId: leg.id,
      ok: false,
      error: error.message,
      guardTripped: error instanceof MassDeletionGuardError,
    };
  }
}

/**
 * Run the mirror over its configured legs.
 *
 * Dry-run (the default) computes and returns the plan for every leg without
 * writing. `--apply` performs the writes and per-leg commits.
 */
export async function runMirror(config: MirrorConfig, opts: RunOptions): Promise<RunReport> {
  const state = loadState(config.repoRoot);
  const mirroredAt = new Date().toISOString();
  const legs = opts.legFilter ? config.legs.filter(l => l.id === opts.legFilter) : config.legs;

  const reports: LegReport[] = [];
  for (const leg of legs) {
    reports.push(await runLeg(config, state, leg, opts, mirroredAt));
  }

  return { dryRun: opts.dryRun, legs: reports, ok: reports.every(r => r.ok) };
}
