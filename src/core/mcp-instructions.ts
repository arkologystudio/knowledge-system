/**
 * MCP server instructions — the `instructions` string returned in the MCP
 * `initialize` result. Clients such as claude.ai and Claude Desktop add it to
 * the model's context whenever the connector is attached, so a brain can tell
 * any connected agent how it wants to be worked with (house style, linking
 * rules, what never to store) without the person installing anything.
 *
 * Two operator-set sources, page first:
 *   - `mcp.instructions_page` — a page slug (e.g. `habitat-guide`). Its
 *     compiled truth is served, so the instructions live in the wiki and the
 *     organisation edits them like any other note.
 *   - `mcp.instructions` — an inline string, for brains without such a page.
 *
 * Unset → no instructions (unchanged behaviour). Values are read through a
 * short TTL cache because the HTTP server builds a fresh MCP server per
 * request, and are capped so a long page cannot flood every client context.
 * Failures never break `initialize`: they degrade to the inline string or to
 * nothing.
 */
import type { BrainEngine } from './engine.ts';

export const MCP_INSTRUCTIONS_KEY = 'mcp.instructions';
export const MCP_INSTRUCTIONS_PAGE_KEY = 'mcp.instructions_page';

/** Upper bound on served instructions, in characters. */
export const MCP_INSTRUCTIONS_MAX_CHARS = 6000;
const CACHE_TTL_MS = 60_000;

let cache: { at: number; value: string | undefined } | null = null;

/** Test seam: forget the cached value. */
export function resetMcpInstructionsCache(): void {
  cache = null;
}

/** Drop YAML frontmatter and trim; cap at the limit on a line boundary. */
export function normaliseInstructions(raw: string): string | undefined {
  let text = raw.replace(/^﻿/, '');
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) text = text.slice(end + 4);
  }
  text = text.trim();
  if (!text) return undefined;
  if (text.length <= MCP_INSTRUCTIONS_MAX_CHARS) return text;
  const cut = text.lastIndexOf('\n', MCP_INSTRUCTIONS_MAX_CHARS);
  const head = text.slice(0, cut > MCP_INSTRUCTIONS_MAX_CHARS / 2 ? cut : MCP_INSTRUCTIONS_MAX_CHARS).trimEnd();
  return `${head}\n\n(Truncated. Read the full page with get_page.)`;
}

export async function resolveMcpInstructions(
  engine: BrainEngine,
  now: number = Date.now(),
): Promise<string | undefined> {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  let value: string | undefined;
  try {
    const slug = (await engine.getConfig(MCP_INSTRUCTIONS_PAGE_KEY))?.trim();
    if (slug) {
      const page = await engine.getPage(slug);
      if (page?.compiled_truth) {
        const body = normaliseInstructions(page.compiled_truth);
        if (body) value = `${body}\n\n(Source: the "${slug}" page in this brain.)`;
      }
    }
    if (value === undefined) {
      const inline = await engine.getConfig(MCP_INSTRUCTIONS_KEY);
      if (inline) value = normaliseInstructions(inline);
    }
  } catch {
    value = undefined;
  }

  cache = { at: now, value };
  return value;
}
