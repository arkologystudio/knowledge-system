/**
 * Source Mirror — runner workflow template (structural smoke).
 *
 * The scheduled runner is a GitHub Actions workflow that lives on the BRAIN repo.
 * We can't run Actions here, but we can assert the template has the properties the
 * design requires: a schedule + manual trigger, an ephemeral run, dry-run vs apply,
 * per-leg isolation surfaced as a failure, a push that carries successful legs even
 * when a leg failed, and credentials that come only from secrets (never inline).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { safeLoad } from 'js-yaml';

const raw = readFileSync('templates/mirror/mirror.yml', 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wf = safeLoad(raw) as any;
const steps: Array<Record<string, unknown>> = wf.jobs.mirror.steps;
const stepByName = (needle: string) =>
  steps.find(s => String(s.name ?? '').toLowerCase().includes(needle.toLowerCase()));

describe('runner workflow template', () => {
  test('runs on a schedule and can be dispatched manually', () => {
    expect(wf.on.schedule[0].cron).toBeDefined();
    // 4-hourly stays within the free-tier allowance (documented knob).
    expect(wf.on.schedule[0].cron).toContain('*/4');
    expect(wf.on).toHaveProperty('workflow_dispatch');
    expect(wf.on.workflow_dispatch.inputs).toHaveProperty('dry_run');
  });

  test('requests only contents:write and serialises runs', () => {
    expect(wf.permissions.contents).toBe('write');
    expect(wf.concurrency.group).toBe('source-mirror');
    expect(wf.concurrency['cancel-in-progress']).toBe(false);
  });

  test('applies by default and honours the dry-run input', () => {
    const run = stepByName('Run the mirror');
    expect(run).toBeDefined();
    const script = String(run!.run);
    expect(script).toContain('--apply');
    expect(script).toContain('--dry-run');
    expect(script).toContain('bun run mirror run');
    // The leg failure must not abort the whole job before the push.
    expect(run!['continue-on-error']).toBe(true);
  });

  test('pushes successful legs even when a leg failed, and only when not dry-run', () => {
    const push = stepByName('Push mirrored commits');
    expect(push).toBeDefined();
    expect(String(push!.if)).toContain('dry_run');
    const fail = stepByName('Surface leg failures');
    expect(fail).toBeDefined();
    expect(String(fail!.if)).toContain("steps.mirror.outcome == 'failure'");
    expect(String(fail!.run)).toContain('exit 1'); // a failed leg still fails the job (notification)
  });

  test('every credential comes from a secret — none is inline', () => {
    for (const secret of ['NOTION_TOKEN', 'RCLONE_CONF', 'KS_REPO_TOKEN', 'BRAIN_REPO_TOKEN']) {
      expect(raw).toContain(`secrets.${secret}`);
    }
    // No obviously-inline token literals in the template.
    expect(raw).not.toMatch(/secret_[a-zA-Z0-9]{16,}/);
    expect(raw).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
  });

  test('extraction runs in the ephemeral runner (rclone + bun set up in-job)', () => {
    expect(stepByName('Setup Bun')).toBeDefined();
    expect(stepByName('Setup rclone')).toBeDefined();
    expect(stepByName('Configure rclone')).toBeDefined();
  });
});
