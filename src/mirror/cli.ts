#!/usr/bin/env bun
/**
 * Source Mirror CLI.
 *
 *   bun src/mirror/cli.ts run --repo <brain-repo> --config <config.json> [--dry-run|--apply] [--leg <id>]
 *
 * Dry-run is the DEFAULT — application must be explicit (`--apply`). The config
 * file lists the legs to run; each leg is built from the registry by its `kind`.
 * Legs land in their own tasks; with none registered this is a well-behaved no-op.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import './legs'; // trigger leg self-registration
import { buildLeg, type LegConfig } from './registry';
import { summarisePlan } from './reconcile';
import { runMirror } from './run';
import type { MirrorConfig } from './types';

interface FileConfig {
  legs?: LegConfig[];
  massDeletionThreshold?: number;
}

interface ParsedArgs {
  repo: string;
  config: string;
  dryRun: boolean;
  leg?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { repo: '', config: '', dryRun: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'run') continue;
    else if (a === '--repo') args.repo = argv[++i] ?? '';
    else if (a === '--config') args.config = argv[++i] ?? '';
    else if (a === '--apply') args.dryRun = false;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--leg') args.leg = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.repo) throw new Error('Missing --repo <path to the brain git repository>.');
  if (!args.config) throw new Error('Missing --config <path to the mirror config json>.');

  const fileConfig = JSON.parse(readFileSync(args.config, 'utf8')) as FileConfig;
  const legs = (fileConfig.legs ?? []).map(buildLeg);
  const config: MirrorConfig = {
    repoRoot: resolve(args.repo),
    legs,
    massDeletionThreshold: fileConfig.massDeletionThreshold,
  };

  const report = await runMirror(config, { dryRun: args.dryRun, legFilter: args.leg });
  const tag = report.dryRun ? ' (dry-run)' : '';
  for (const leg of report.legs) {
    if (leg.ok && leg.plan) {
      process.stdout.write(`${leg.legId}: ${summarisePlan(leg.plan)}${tag}\n`);
    } else {
      process.stdout.write(`${leg.legId}: FAILED - ${leg.error}\n`);
    }
  }
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`source-mirror: ${message}\n`);
  process.exitCode = 1;
});
