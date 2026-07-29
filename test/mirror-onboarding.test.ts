/**
 * Source Mirror — onboarding guide (structural smoke).
 *
 * The acceptance criterion "a person who has never used a terminal completes
 * setup" is human-verifiable, not machine-verifiable. What we CAN pin
 * mechanically: the guide exists, targets a non-technical operator, names every
 * human-provisioned credential (and that they are never delegated), references
 * the templates an operator copies, and states the safety rails.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const guide = readFileSync('docs/guides/source-mirror-onboarding.md', 'utf8');

describe('onboarding guide', () => {
  test('targets a non-technical operator with a time budget', () => {
    expect(guide).toContain('never used a terminal');
    expect(guide).toContain('30 minutes');
  });

  test('names every human-provisioned credential', () => {
    for (const secret of ['NOTION_TOKEN', 'RCLONE_CONF', 'KS_REPO_TOKEN', 'BRAIN_REPO_TOKEN']) {
      expect(guide).toContain(secret);
    }
  });

  test('makes credential provisioning a human-only step', () => {
    expect(guide.toLowerCase()).toContain('never'); // "the assistant never creates ... a credential"
    expect(guide).toMatch(/never (create|mint|paste|type).*(credential|token)/i);
  });

  test('references the templates an operator copies', () => {
    expect(guide).toContain('templates/mirror/mirror.yml');
    expect(guide).toContain('templates/mirror/mirror.config.example.json');
    expect(guide).toContain('templates/mirror/obsidian-setup.md');
  });

  test('covers all three sources and the connect-to-brain step', () => {
    expect(guide).toContain('Google Drive');
    expect(guide).toContain('Notion');
    expect(guide).toContain('Obsidian');
    expect(guide).toContain('gbrain sources add');
  });

  test('states the safety rails a non-technical operator must trust', () => {
    expect(guide).toContain('sources/'); // the write allowlist
    expect(guide.toLowerCase()).toContain('empty'); // the mass-deletion guard
    expect(guide.toLowerCase()).toContain('dry run'); // preview without changing
  });
});
