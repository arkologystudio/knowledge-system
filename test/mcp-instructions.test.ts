import { describe, test, expect, beforeEach } from 'bun:test';
import {
  resolveMcpInstructions,
  normaliseInstructions,
  resetMcpInstructionsCache,
  MCP_INSTRUCTIONS_MAX_CHARS,
} from '../src/core/mcp-instructions.ts';

function stubEngine(config: Record<string, string>, pages: Record<string, string>, calls = { page: 0 }) {
  return {
    async getConfig(key: string) { return config[key] ?? null; },
    async getPage(slug: string) {
      calls.page++;
      return slug in pages ? ({ slug, compiled_truth: pages[slug] } as any) : null;
    },
  } as any;
}

describe('mcp server instructions', () => {
  beforeEach(() => resetMcpInstructionsCache());

  test('unset config serves no instructions', async () => {
    expect(await resolveMcpInstructions(stubEngine({}, {}))).toBeUndefined();
  });

  test('instructions_page serves the page body without frontmatter, citing the slug', async () => {
    const engine = stubEngine(
      { 'mcp.instructions_page': 'habitat-guide' },
      { 'habitat-guide': '---\ntitle: "Guide"\n---\n\n# Guide\n\nLink with full paths.\n' },
    );
    const out = await resolveMcpInstructions(engine);
    expect(out).toStartWith('# Guide');
    expect(out).toContain('Link with full paths.');
    expect(out).not.toContain('title:');
    expect(out).toContain('"habitat-guide" page');
  });

  test('missing page falls back to the inline string', async () => {
    const engine = stubEngine({ 'mcp.instructions_page': 'nope', 'mcp.instructions': 'Be kind.' }, {});
    expect(await resolveMcpInstructions(engine)).toBe('Be kind.');
  });

  test('a throwing engine degrades to no instructions', async () => {
    const engine = { async getConfig() { throw new Error('db down'); }, async getPage() { return null; } } as any;
    expect(await resolveMcpInstructions(engine)).toBeUndefined();
  });

  test('result is cached for the TTL, then re-read', async () => {
    const calls = { page: 0 };
    const engine = stubEngine({ 'mcp.instructions_page': 'g' }, { g: 'Hello' }, calls);
    await resolveMcpInstructions(engine, 1_000);
    await resolveMcpInstructions(engine, 30_000);
    expect(calls.page).toBe(1);
    await resolveMcpInstructions(engine, 1_000 + 61_000);
    expect(calls.page).toBe(2);
  });

  test('long text is capped on a line boundary with a pointer to the full page', () => {
    const long = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
    const out = normaliseInstructions(long)!;
    expect(out.length).toBeLessThanOrEqual(MCP_INSTRUCTIONS_MAX_CHARS + 80);
    expect(out).toContain('(Truncated. Read the full page with get_page.)');
  });
});
