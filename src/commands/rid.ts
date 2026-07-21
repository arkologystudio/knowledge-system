/**
 * gbrain rid — Reference Identifier operations.
 *
 * Subcommands:
 *   gbrain rid backfill [--source <id>] [--limit N] [--dry-run] [--json]
 *     Stamp each page's Reference Identifier into its source markdown as a
 *     `ref_id` frontmatter field. The identifier ALREADY exists in the database
 *     (minted by the column default in migration v128) — this pass writes it
 *     back to disk so it survives a wipe-and-re-ingest. That is what makes
 *     identity a property of the CONTENT rather than of database state.
 *
 *   gbrain rid resolve <rid> [--json]
 *     Resolve an identifier to the page it names, plus its locators.
 *
 *   gbrain rid manifest <slug> [--source <id>] [--json]
 *     Emit the portable descriptor — identifier, timestamp, RFC 8785 content
 *     hash — that a recipient can verify against content they received.
 *
 * WHY BACKFILL IS A SEPARATE PASS rather than a write-through on every ingest:
 * stamping inline would make every import a repo write, which fights
 * `gitFirstPageWrite`'s dirty-tree check — its own comment warns that a
 * write-through "dirties the checkout, then every subsequent commit_page
 * preview fails with repo_dirty". Batching keeps ingest fast and makes the
 * stamping pass auditable as one reviewable diff.
 *
 * Writes go through `writeBrainPage`, whose mandatory backup is the contract
 * that replaces git-tree-clean for non-git brain repos. Every file this command
 * touches gets a backup under ~/.gbrain/backups/frontmatter/ first.
 */

import { existsSync, readFileSync } from 'fs';
import type { BrainEngine } from '../core/engine.ts';
import { serializeMarkdown, parseMarkdown } from '../core/markdown.ts';
import {
  writeBrainPage,
  makeFrontmatterBackupRunId,
  BrainWriterError,
} from '../core/brain-writer.ts';
import { resolvePageFilePath } from '../core/markdown.ts';
import { validateSourceId } from '../core/utils.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import {
  RID_FRONTMATTER_KEY,
  validateRid,
  resolveLocators,
  buildManifest,
} from '../core/rid.ts';

export async function runRid(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printHelp();
    return;
  }
  const rest = args.slice(1);
  if (sub === 'backfill') return runBackfill(engine, rest);
  if (sub === 'resolve') return runResolve(engine, rest);
  if (sub === 'manifest') return runManifest(engine, rest);

  process.stderr.write(`Unknown subcommand: rid ${sub}\n\n`);
  printHelp();
  process.exitCode = 1;
}

function printHelp(): void {
  process.stdout.write(`gbrain rid — Reference Identifier operations

A Reference Identifier (RID) is a page's permanent name. Unlike a slug — which
is derived from the path and therefore dies when the page is renamed — a RID is
minted once and never reissued. Syntax: orn:<namespace>:<reference>.

Usage:
  gbrain rid backfill [--source <id>] [--limit N] [--dry-run] [--json]
      Stamp each page's identifier into its source markdown as a "${RID_FRONTMATTER_KEY}"
      frontmatter field, so the identity survives a full re-ingest from source.
      Every file written gets a backup first. --dry-run reports without writing.

  gbrain rid resolve <rid> [--json]
      Resolve an identifier to the page it names, plus its locators.

  gbrain rid manifest <slug> [--source <id>] [--json]
      Emit the portable descriptor (identifier, timestamp, RFC 8785 hash) a
      recipient can verify against the content they received.
`);
}

// ---------------------------------------------------------------------------
// backfill
// ---------------------------------------------------------------------------

interface BackfillResult {
  scanned: number;
  stamped: number;
  already_stamped: number;
  missing_file: number;
  errors: Array<{ slug: string; error: string }>;
  dry_run: boolean;
}

async function runBackfill(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const sourceId = readFlag(args, '--source') ?? 'default';
  const limitRaw = readFlag(args, '--limit');
  const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;

  validateSourceId(sourceId);

  const sources = await engine.listAllSources({ includeArchived: true });
  const source = sources.find((s: { id: string }) => s.id === sourceId);
  if (!source?.local_path) {
    process.stderr.write(
      `[rid] source "${sourceId}" has no local_path, so there are no source files to stamp.\n` +
      `      Register the source's checkout with: gbrain sources add\n`,
    );
    process.exitCode = 1;
    return;
  }
  const localPath = source.local_path;

  const pages = await engine.listPages({
    sourceId,
    ...(limit !== undefined ? { limit } : { limit: 100_000 }),
  });

  const result: BackfillResult = {
    scanned: 0,
    stamped: 0,
    already_stamped: 0,
    missing_file: 0,
    errors: [],
    dry_run: dryRun,
  };

  // One backup run-id for the whole pass so the operator can find (or roll
  // back) every file this invocation touched as a single unit.
  const backupRunId = makeFrontmatterBackupRunId();

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('rid.backfill', pages.length);

  for (const listed of pages) {
    progress.tick();
    result.scanned++;
    try {
      // listPages returns a projection; re-read the full page so we have the
      // body, frontmatter, and rid in one consistent snapshot.
      const page = await engine.getPage(listed.slug, { sourceId });
      if (!page) continue;
      if (!page.rid) {
        // Should be unreachable once v128 has run (the column is NOT NULL).
        // Surface rather than silently skip: a page with no identity after
        // migration means the migration didn't land on this brain.
        result.errors.push({
          slug: page.slug,
          error: 'page has no rid — run `gbrain apply-migrations` (v128) first',
        });
        continue;
      }

      const filePath = resolvePageFilePath(localPath, page.slug, page.source_id);
      if (!existsSync(filePath)) {
        // A DB-only page (put_page without write-through, dream output, code
        // page) has no source file to stamp. Not an error — just nothing to do.
        result.missing_file++;
        continue;
      }

      const raw = readFileSync(filePath, 'utf8');
      const parsed = parseMarkdown(raw);
      const existingRid = (parsed.frontmatter as Record<string, unknown>)[RID_FRONTMATTER_KEY];
      if (typeof existingRid === 'string' && existingRid === page.rid) {
        result.already_stamped++;
        continue;
      }
      if (typeof existingRid === 'string' && existingRid.length > 0 && existingRid !== page.rid) {
        // The file claims a DIFFERENT identity than the DB row holds. Never
        // silently overwrite an identifier — that is the one operation a
        // mint-once system must refuse. Surface it and move on.
        result.errors.push({
          slug: page.slug,
          error:
            `file declares ${RID_FRONTMATTER_KEY} "${existingRid}" but the brain holds ` +
            `"${page.rid}". Refusing to overwrite an identifier; reconcile by hand.`,
        });
        continue;
      }

      if (dryRun) {
        result.stamped++;
        continue;
      }

      const stamped = serializeMarkdown(
        { ...(parsed.frontmatter as Record<string, unknown>), [RID_FRONTMATTER_KEY]: page.rid },
        parsed.compiled_truth ?? '',
        parsed.timeline ?? '',
        { type: parsed.type, title: parsed.title, tags: parsed.tags },
      );

      writeBrainPage(filePath, stamped, {
        sourcePath: localPath,
        backupRunId,
      });
      result.stamped++;
    } catch (e) {
      const msg = e instanceof BrainWriterError ? `${e.code}: ${e.message}` : (e as Error).message;
      result.errors.push({ slug: listed.slug, error: msg });
    }
  }

  progress.finish();

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(
      `${dryRun ? 'Would stamp' : 'Stamped'} ${result.stamped} page(s) in source "${sourceId}".\n` +
      `  scanned:         ${result.scanned}\n` +
      `  already stamped: ${result.already_stamped}\n` +
      `  no source file:  ${result.missing_file}\n` +
      `  errors:          ${result.errors.length}\n`,
    );
    for (const e of result.errors) {
      process.stderr.write(`  ! ${e.slug}: ${e.error}\n`);
    }
    if (!dryRun && result.stamped > 0) {
      process.stdout.write(
        `\nBackups for this run: ~/.gbrain/backups/frontmatter/${backupRunId}/\n` +
        `The stamped ${RID_FRONTMATTER_KEY} field does NOT change any page's content hash, ` +
        `so this pass does not trigger a re-embed.\n`,
      );
    }
  }
  if (result.errors.length > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

async function runResolve(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const rid = args.find(a => !a.startsWith('--'));
  if (!rid) {
    process.stderr.write('Usage: gbrain rid resolve <rid> [--json]\n');
    process.exitCode = 1;
    return;
  }
  try {
    validateRid(rid);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  const locators = resolveLocators(rid);
  const page = await engine.getPageByRid(rid, { includeDeleted: true });

  if (json) {
    process.stdout.write(JSON.stringify({
      rid,
      resolved: page !== null,
      ...(page ? { slug: page.slug, title: page.title, type: page.type, source_id: page.source_id } : {}),
      locators,
    }, null, 2) + '\n');
    return;
  }

  if (page) {
    process.stdout.write(`${rid}\n  → ${page.slug} (${page.type}) in source "${page.source_id}"\n    ${page.title}\n`);
  } else {
    process.stdout.write(`${rid}\n  → not held by this brain\n`);
  }
  if (locators.length > 0) {
    process.stdout.write('  locators:\n');
    for (const l of locators) process.stdout.write(`    [${l.kind}] ${l.uri}\n`);
  }
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

async function runManifest(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const sourceId = readFlag(args, '--source') ?? 'default';
  const slug = args.find(a => !a.startsWith('--') && a !== sourceId);
  if (!slug) {
    process.stderr.write('Usage: gbrain rid manifest <slug> [--source <id>] [--json]\n');
    process.exitCode = 1;
    return;
  }
  const page = await engine.getPage(slug, { sourceId });
  if (!page) {
    process.stderr.write(`Page not found: ${slug} (source "${sourceId}")\n`);
    process.exitCode = 1;
    return;
  }
  if (!page.rid) {
    process.stderr.write(
      `Page ${slug} has no rid. Run \`gbrain apply-migrations\` so migration v128 lands.\n`,
    );
    process.exitCode = 1;
    return;
  }
  const tags = await engine.getTags(page.slug, { sourceId: page.source_id });
  const manifest = buildManifest(
    page.rid,
    {
      type: page.type,
      title: page.title,
      compiled_truth: page.compiled_truth,
      timeline: page.timeline,
      frontmatter: page.frontmatter,
      tags,
    },
    page.updated_at,
  );

  if (json) {
    process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
  } else {
    process.stdout.write(
      `rid:       ${manifest.rid}\n` +
      `timestamp: ${manifest.timestamp}\n` +
      `hash:      ${manifest.hash}\n` +
      `\nThe hash is SHA-256 over the RFC 8785 canonical JSON of the page contents,\n` +
      `so an implementation in another language reproduces it exactly.\n`,
    );
  }
}

// ---------------------------------------------------------------------------

function readFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}
