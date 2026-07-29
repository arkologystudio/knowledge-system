/**
 * Source Mirror — Google Drive leg: content-tier classification, extraction
 * provenance, reference stubs, and the guarantee that binaries never enter the
 * repository. The rclone/credential surface is faked; the pure logic is real.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
  ExtractorUnavailableError,
  PlainTextExtractor,
  type ArtifactExtractor,
} from '../src/core/artifact/extractors';
import { DriveLeg, type DriveBackend, type DriveEntry } from '../src/mirror/legs/drive';
import { runMirror } from '../src/mirror/run';
import type { SourceObject } from '../src/mirror/types';
import { cleanupRepo, commitCount, makeTempRepo, trackedFiles } from './mirror-test-helpers';

class FakeDrive implements DriveBackend {
  downloads: string[] = [];
  constructor(
    private entries: DriveEntry[],
    private docs: Record<string, string> = {},
    private blobs: Record<string, Uint8Array> = {},
  ) {}
  async list(): Promise<DriveEntry[]> {
    return this.entries;
  }
  async exportMarkdown(e: DriveEntry): Promise<string> {
    return this.docs[e.id] ?? `# ${e.name}\n`;
  }
  async download(e: DriveEntry): Promise<Uint8Array> {
    this.downloads.push(e.id);
    return this.blobs[e.id] ?? new Uint8Array([1, 2, 3, 4]);
  }
}

const pdfExtractor: ArtifactExtractor = {
  name: 'unstructured',
  extensions: ['.pdf'],
  supports: ext => ext === '.pdf',
  async extract() {
    return { text: 'EXTRACTED PDF TEXT', title: null, contentType: 'application/pdf', meta: { version: 'v0.1' } };
  },
};
const unavailableExtractor: ArtifactExtractor = {
  name: 'unstructured',
  extensions: ['.pdf'],
  supports: ext => ext === '.pdf',
  async extract() {
    throw new ExtractorUnavailableError('unstructured', 'GBRAIN_UNSTRUCTURED_URL not set');
  },
};

function entry(p: Partial<DriveEntry> & { id: string; name: string; mimeType: string }): DriveEntry {
  return { path: p.name, modTime: '2026-07-01T00:00:00.000Z', ...p };
}

async function collect(leg: DriveLeg): Promise<SourceObject[]> {
  const out: SourceObject[] = [];
  for await (const o of leg.list()) out.push(o);
  return out;
}

describe('content tiers', () => {
  test('a Google Doc exports natively to markdown (no original hash, no extractor)', async () => {
    const e = entry({ id: 'doc1', name: 'Strategy', mimeType: 'application/vnd.google-apps.document' });
    const backend = new FakeDrive([e], { doc1: '# Strategy\n\nthe plan\n' });
    const [obj] = await collect(new DriveLeg({ backend }));
    expect(obj.upstreamId).toBe('doc1');
    expect(obj.title).toBe('Strategy');
    expect(obj.body).toContain('the plan');
    expect(obj.originalSha256).toBeUndefined();
    expect(obj.extractor).toBeUndefined();
    expect(backend.downloads).toEqual([]); // gdocs are exported, not downloaded
  });

  test('a born-digital PDF is extracted, with original hash + extractor version in provenance', async () => {
    const e = entry({ id: 'pdf1', name: 'report.pdf', mimeType: 'application/pdf' });
    const backend = new FakeDrive([e], {}, { pdf1: new Uint8Array([9, 8, 7]) });
    const [obj] = await collect(new DriveLeg({ backend, resolveExtractor: () => pdfExtractor }));
    expect(obj.body).toBe('EXTRACTED PDF TEXT');
    expect(obj.originalSha256).toBeDefined();
    expect(obj.originalSha256).toHaveLength(64); // sha256 hex
    expect(obj.extractor).toBe('unstructured@v0.1');
    expect(backend.downloads).toEqual(['pdf1']);
  });

  test('a newer extractor version changes the provenance tag', async () => {
    const e = entry({ id: 'pdf1', name: 'report.pdf', mimeType: 'application/pdf' });
    const v2: ArtifactExtractor = {
      ...pdfExtractor,
      async extract() {
        return { text: 'better', title: null, contentType: 'application/pdf', meta: { version: 'v0.2' } };
      },
    };
    const backend = new FakeDrive([e]);
    const [obj] = await collect(new DriveLeg({ backend, resolveExtractor: () => v2 }));
    expect(obj.extractor).toBe('unstructured@v0.2');
    expect(obj.body).toBe('better');
  });

  test('when the extractor is unavailable, the file falls back to a reference stub (leg does not fail)', async () => {
    const e = entry({ id: 'pdf1', name: 'report.pdf', mimeType: 'application/pdf' });
    const backend = new FakeDrive([e]);
    const [obj] = await collect(new DriveLeg({ backend, resolveExtractor: () => unavailableExtractor }));
    expect(obj.body).toContain('not extracted inline');
    expect(obj.body).toContain('extractor unavailable');
    expect(obj.originalSha256).toBeUndefined();
  });

  test('media is a reference stub and is never downloaded', async () => {
    const e = entry({ id: 'img1', name: 'photo.png', mimeType: 'image/png' });
    const backend = new FakeDrive([e]);
    const [obj] = await collect(new DriveLeg({ backend }));
    expect(obj.body).toContain('not extracted inline');
    expect(backend.downloads).toEqual([]); // no wasteful download for media
  });

  test('a plain text file is read through the default extractor', async () => {
    const e = entry({ id: 'txt1', name: 'notes.txt', mimeType: 'text/plain' });
    const backend = new FakeDrive([e], {}, { txt1: new TextEncoder().encode('plain notes here') });
    const [obj] = await collect(new DriveLeg({ backend, resolveExtractor: () => new PlainTextExtractor() }));
    expect(obj.body).toContain('plain notes here');
    expect(obj.originalSha256).toBeDefined();
  });

  test('an unknown binary with no real extractor gets a reference stub, not garbage', async () => {
    const e = entry({ id: 'bin1', name: 'archive.zip', mimeType: 'application/zip' });
    const backend = new FakeDrive([e]);
    // default resolver returns plaintext for .zip → leg must decline and stub it
    const [obj] = await collect(new DriveLeg({ backend, resolveExtractor: () => new PlainTextExtractor() }));
    expect(obj.body).toContain('no extractor for .zip');
    expect(backend.downloads).toEqual([]);
  });
});

describe('end-to-end through the harness', () => {
  const repos: string[] = [];
  afterEach(() => {
    while (repos.length) cleanupRepo(repos.pop() as string);
  });

  test('mirrors Drive content as markdown under sources/drive and never commits a binary', async () => {
    const dir = makeTempRepo();
    repos.push(dir);
    const entries: DriveEntry[] = [
      entry({ id: 'doc1', name: 'Plan', mimeType: 'application/vnd.google-apps.document' }),
      entry({ id: 'pdf1', name: 'report.pdf', mimeType: 'application/pdf' }),
      entry({ id: 'img1', name: 'photo.png', mimeType: 'image/png' }),
    ];
    const backend = new FakeDrive(entries, { doc1: '# Plan\nbody\n' });
    const leg = new DriveLeg({ backend, resolveExtractor: () => pdfExtractor });

    const report = await runMirror({ repoRoot: dir, legs: [leg] }, { dryRun: false });
    expect(report.ok).toBe(true);
    const files = trackedFiles(dir, 'sources');
    expect(files.length).toBe(3);
    expect(files.every(f => f.startsWith('sources/drive/') && f.endsWith('.md'))).toBe(true);
    expect(files.some(f => f.endsWith('.pdf') || f.endsWith('.png'))).toBe(false);
    expect(commitCount(dir)).toBeGreaterThan(1);
    expect(existsSync(`${dir}/sources/drive`)).toBe(true);
  });
});
