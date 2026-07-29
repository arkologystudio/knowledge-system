/**
 * Notion source leg — the only leg requiring substantial custom code.
 *
 * An **internal** Notion integration (≈5 clicks for the installing org, no review
 * cycle) enumerates pages via the search endpoint sorted by last-edited time, and
 * each page is fetched through the block API and converted to markdown. Least
 * privilege is inherent: search only returns pages explicitly shared with the
 * integration, so a page nobody shared never appears. Identity is the stable
 * Notion page id (`orn:notion.page:<id>`), so a rename is a move, not a
 * delete-and-recreate.
 *
 * The official markdown endpoint is restricted to PUBLIC integrations, so an
 * internal integration must walk the block tree itself — that converter is the
 * meat of this file and is fully unit-tested against fixtures matching the real
 * Notion REST shapes. The HTTP/credential surface sits behind `NotionBackend`;
 * the integration token is human-provisioned, never minted here.
 *
 * Design: source-mirror-pattern.md (Notion leg).
 */
import { registerLeg, type LegConfig } from '../registry';
import type { MirrorSource, SourceObject } from '../types';

// ── Notion REST shapes (the subset the converter reads) ─────────────────────

export interface NotionAnnotations {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  code?: boolean;
}

export interface NotionRichText {
  plain_text?: string;
  href?: string | null;
  annotations?: NotionAnnotations;
  text?: { content?: string; link?: { url?: string } | null };
}

/** A Notion block. Loosely typed — only the read fields matter. */
export interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
}

/** Page metadata from search (the backend extracts the title). */
export interface NotionPageMeta {
  id: string;
  title: string;
  lastEditedTime: string;
}

/** The impure Notion surface. Real impl calls the REST API; tests supply a fake. */
export interface NotionBackend {
  /** Full enumeration of shared pages (search sorted by last-edited; paginated internally). */
  listPages(): Promise<NotionPageMeta[]>;
  /** Top-level blocks of a page. */
  getBlocks(pageId: string): Promise<NotionBlock[]>;
  /** Children of a block (for nesting). */
  getChildren(blockId: string): Promise<NotionBlock[]>;
}

// ── Rich text → markdown ────────────────────────────────────────────────────

function applyAnnotations(text: string, ann: NotionAnnotations): string {
  if (text.length === 0) return text;
  let s = text;
  if (ann.code) s = '`' + s + '`';
  if (ann.bold) s = '**' + s + '**';
  if (ann.italic) s = '*' + s + '*';
  if (ann.strikethrough) s = '~~' + s + '~~';
  return s;
}

/** Convert a rich-text array to inline markdown (annotations + links). */
export function richTextToMarkdown(rt: NotionRichText[] | undefined): string {
  if (!rt) return '';
  return rt
    .map(t => {
      const styled = applyAnnotations(t.plain_text ?? '', t.annotations ?? {});
      const href = t.href ?? t.text?.link?.url ?? null;
      return href ? `[${styled}](${href})` : styled;
    })
    .join('');
}

/** Plain concatenation with no markdown escaping — for code blocks. */
function richTextPlain(rt: NotionRichText[] | undefined): string {
  return (rt ?? []).map(t => t.plain_text ?? '').join('');
}

function fileUrl(data: Record<string, unknown>): string {
  const external = data.external as { url?: string } | undefined;
  const file = data.file as { url?: string } | undefined;
  return external?.url ?? file?.url ?? (data.url as string) ?? '';
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map(l => (l.length ? prefix + l : l))
    .join('\n');
}

const NESTING_TYPES = new Set([
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  'quote',
  'callout',
]);

/** Render one block to markdown (its own line; children handled by the caller path). */
async function renderBlock(
  block: NotionBlock,
  getChildren: (blockId: string) => Promise<NotionBlock[]>,
): Promise<string | null> {
  const type = block.type;
  const data = (block[type] as Record<string, unknown>) ?? {};
  const rich = data.rich_text as NotionRichText[] | undefined;
  const rt = richTextToMarkdown(rich);

  let line: string | null;
  switch (type) {
    case 'paragraph':
      line = rt;
      break;
    case 'heading_1':
      line = '# ' + rt;
      break;
    case 'heading_2':
      line = '## ' + rt;
      break;
    case 'heading_3':
      line = '### ' + rt;
      break;
    case 'bulleted_list_item':
    case 'toggle':
      line = '- ' + rt;
      break;
    case 'numbered_list_item':
      line = '1. ' + rt;
      break;
    case 'to_do':
      line = `- [${data.checked ? 'x' : ' '}] ` + rt;
      break;
    case 'quote':
      line = '> ' + rt;
      break;
    case 'callout': {
      const icon = (data.icon as { emoji?: string } | undefined)?.emoji;
      line = '> ' + (icon ? icon + ' ' : '') + rt;
      break;
    }
    case 'code': {
      const lang = (data.language as string) ?? '';
      line = '```' + lang + '\n' + richTextPlain(rich) + '\n```';
      break;
    }
    case 'divider':
      line = '---';
      break;
    case 'child_page':
      line = '- ' + ((data.title as string) ?? 'Untitled');
      break;
    case 'image':
    case 'file':
    case 'video':
    case 'pdf': {
      const url = fileUrl(data);
      const caption = richTextToMarkdown(data.caption as NotionRichText[] | undefined);
      line = url ? `![${caption || type}](${url})` : caption;
      break;
    }
    case 'bookmark':
    case 'embed':
    case 'link_preview': {
      const url = (data.url as string) ?? '';
      line = url ? `[${url}](${url})` : '';
      break;
    }
    case 'equation':
      line = data.expression ? '$$' + (data.expression as string) + '$$' : '';
      break;
    default:
      // Unknown block: emit its rich text if it has any, otherwise skip it.
      line = rich ? rt : null;
  }
  if (line === null) return null;

  if (block.has_children && NESTING_TYPES.has(type)) {
    const kids = await getChildren(block.id);
    const childMd = await blocksToMarkdown(kids, getChildren);
    if (childMd) line += '\n' + indent(childMd, '  ');
  }
  return line;
}

/** Convert a list of blocks to markdown, resolving nested children on demand. */
export async function blocksToMarkdown(
  blocks: NotionBlock[],
  getChildren: (blockId: string) => Promise<NotionBlock[]>,
): Promise<string> {
  const parts: string[] = [];
  for (const block of blocks) {
    const md = await renderBlock(block, getChildren);
    if (md !== null) parts.push(md);
  }
  return parts.join('\n\n');
}

// ── The leg ─────────────────────────────────────────────────────────────────

export interface NotionLegOptions {
  id?: string;
  backend: NotionBackend;
}

export class NotionLeg implements MirrorSource {
  readonly id: string;
  readonly namespace = 'notion.page' as const;
  private readonly backend: NotionBackend;

  constructor(opts: NotionLegOptions) {
    this.id = opts.id ?? 'notion';
    this.backend = opts.backend;
  }

  async *list(): AsyncIterable<SourceObject> {
    const pages = await this.backend.listPages();
    for (const page of pages) {
      const blocks = await this.backend.getBlocks(page.id);
      const body = await blocksToMarkdown(blocks, id => this.backend.getChildren(id));
      yield {
        upstreamId: page.id,
        title: page.title,
        body,
        upstreamMtime: page.lastEditedTime,
      };
    }
  }
}

// ── Production backend (REST; not unit-tested — needs a provisioned token) ──

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

/** Extract a page's title from its `properties` (the property of type `title`). */
export function extractTitle(page: { properties?: Record<string, unknown> }): string {
  const props = page.properties ?? {};
  for (const value of Object.values(props)) {
    const prop = value as { type?: string; title?: NotionRichText[] };
    if (prop.type === 'title') return richTextPlain(prop.title) || 'Untitled';
  }
  return 'Untitled';
}

/**
 * Production backend: the Notion REST API with an internal-integration token.
 * The token is provisioned by a human (a Notion integration + page shares) and
 * passed via env — never minted here. Not unit-tested (no token in CI).
 */
export class NotionApiBackend implements NotionBackend {
  constructor(private readonly token: string) {}

  private async api(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(`${NOTION_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(`Notion API ${path} failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  async listPages(): Promise<NotionPageMeta[]> {
    const out: NotionPageMeta[] = [];
    let cursor: string | undefined;
    do {
      const body: Record<string, unknown> = {
        filter: { property: 'object', value: 'page' },
        sort: { timestamp: 'last_edited_time', direction: 'descending' },
        page_size: 100,
      };
      if (cursor) body.start_cursor = cursor;
      const page = (await this.api('/search', { method: 'POST', body: JSON.stringify(body) })) as {
        results: Array<{ id: string; last_edited_time: string; properties?: Record<string, unknown> }>;
        has_more: boolean;
        next_cursor: string | null;
      };
      for (const r of page.results) {
        out.push({ id: r.id, title: extractTitle(r), lastEditedTime: r.last_edited_time });
      }
      cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
    } while (cursor);
    return out;
  }

  private async children(blockId: string): Promise<NotionBlock[]> {
    const out: NotionBlock[] = [];
    let cursor: string | undefined;
    do {
      const qs = cursor ? `?page_size=100&start_cursor=${cursor}` : '?page_size=100';
      const page = (await this.api(`/blocks/${blockId}/children${qs}`)) as {
        results: NotionBlock[];
        has_more: boolean;
        next_cursor: string | null;
      };
      out.push(...page.results);
      cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
    } while (cursor);
    return out;
  }

  getBlocks(pageId: string): Promise<NotionBlock[]> {
    return this.children(pageId);
  }

  getChildren(blockId: string): Promise<NotionBlock[]> {
    return this.children(blockId);
  }
}

/** Build a NotionLeg from config. The token comes from env (`NOTION_TOKEN`), never config. */
export function buildNotionLeg(config: LegConfig): MirrorSource {
  const token = process.env.NOTION_TOKEN ?? '';
  if (!token) {
    throw new Error(
      'notion leg: NOTION_TOKEN is not set. Provision an internal-integration token as a secret (a human step).',
    );
  }
  return new NotionLeg({
    id: typeof config.id === 'string' ? config.id : undefined,
    backend: new NotionApiBackend(token),
  });
}

registerLeg('notion', buildNotionLeg);
