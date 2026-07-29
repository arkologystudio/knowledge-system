/**
 * Source Mirror — config + registry wiring (smoke).
 *
 * Also the Obsidian leg's coverage: Obsidian is configuration, not a fetch leg,
 * so its "test" is that the config contract and registry resolve the legs that DO
 * exist and that the example config an operator copies is valid and buildable.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import '../src/mirror/legs'; // trigger leg self-registration
import { availableKinds, buildLeg } from '../src/mirror/registry';

interface FileConfig {
  massDeletionThreshold?: number;
  legs: Array<{ kind: string; [k: string]: unknown }>;
}

const example = JSON.parse(
  readFileSync('templates/mirror/mirror.config.example.json', 'utf8'),
) as FileConfig;

describe('registry', () => {
  test('the fetch legs self-register', () => {
    expect(availableKinds()).toEqual(['google_drive', 'notion']);
  });

  test('an unknown kind fails with the available kinds named', () => {
    expect(() => buildLeg({ kind: 'myspace' })).toThrow(/Available: google_drive, notion/);
  });
});

describe('example config', () => {
  test('parses and only references registered kinds', () => {
    expect(example.massDeletionThreshold).toBe(0.5);
    for (const leg of example.legs) {
      expect(availableKinds()).toContain(leg.kind);
    }
  });

  test('the Drive leg builds from config (no network at construction)', () => {
    const cfg = example.legs.find(l => l.kind === 'google_drive');
    const leg = buildLeg(cfg as { kind: string });
    expect(leg.id).toBe('drive');
    expect(leg.namespace).toBe('google_drive.file');
  });
});

describe('Obsidian is configuration, not a fetch leg', () => {
  test('no obsidian kind is registered (the vault is pushed by the Obsidian Git plugin)', () => {
    expect(availableKinds()).not.toContain('obsidian');
  });

  test('the operator setup guide exists', () => {
    const guide = readFileSync('templates/mirror/obsidian-setup.md', 'utf8');
    expect(guide).toContain('Obsidian Git');
    expect(guide).toContain('sources/obsidian/');
  });
});
