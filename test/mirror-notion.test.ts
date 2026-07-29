/**
 * Source Mirror — Notion leg: the block-API → markdown converter (the
 * substantial custom code) and the leg's page assembly. Fixtures match the real
 * Notion REST shapes; the HTTP/token surface is faked.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  NotionLeg,
  blocksToMarkdown,
  extractTitle,
  richTextToMarkdown,
  type NotionBackend,
  type NotionBlock,
  type NotionPageMeta,
  type NotionRichText,
} from '../src/mirror/legs/notion';
import { runMirror } from '../src/mirror/run';
import type { SourceObject } from '../src/mirror/types';
import { cleanupRepo, makeTempRepo, trackedFiles } from './mirror-test-helpers';

function rt(text: string, annotations: NotionRichText['annotations'] = {}, href?: string): NotionRichText {
  return { plain_text: text, annotations, href: href ?? null };
}

/** A block with no children. */
function block(type: string, data: Record<string, unknown>, extra: Partial<NotionBlock> = {}): NotionBlock {
  return { id: `b-${Math.random().toString(36).slice(2)}`, type, [type]: data, has_children: false, ...extra };
}

const noChildren = async () => [];

describe('richTextToMarkdown', () => {
  test('applies annotations and links', async () => {
    expect(richTextToMarkdown([rt('bold', { bold: true })])).toBe('**bold**');
    expect(richTextToMarkdown([rt('em', { italic: true })])).toBe('*em*');
    expect(richTextToMarkdown([rt('code', { code: true })])).toBe('`code`');
    expect(richTextToMarkdown([rt('gone', { strikethrough: true })])).toBe('~~gone~~');
    expect(richTextToMarkdown([rt('site', {}, 'https://x.example')])).toBe('[site](https://x.example)');
  });
  test('concatenates runs and preserves plain spans', () => {
    expect(richTextToMarkdown([rt('Hello '), rt('world', { bold: true })])).toBe('Hello **world**');
  });
  test('empty runs contribute nothing', () => {
    expect(richTextToMarkdown([rt('', { bold: true })])).toBe('');
  });
});

describe('blocksToMarkdown', () => {
  test('headings, paragraphs, and a divider', async () => {
    const blocks = [
      block('heading_1', { rich_text: [rt('Title')] }),
      block('paragraph', { rich_text: [rt('Body text.')] }),
      block('divider', {}),
      block('heading_2', { rich_text: [rt('Sub')] }),
    ];
    const md = await blocksToMarkdown(blocks, noChildren);
    expect(md).toBe('# Title\n\nBody text.\n\n---\n\n## Sub');
  });

  test('lists and to-dos', async () => {
    const blocks = [
      block('bulleted_list_item', { rich_text: [rt('one')] }),
      block('numbered_list_item', { rich_text: [rt('first')] }),
      block('to_do', { rich_text: [rt('done')], checked: true }),
      block('to_do', { rich_text: [rt('todo')], checked: false }),
    ];
    const md = await blocksToMarkdown(blocks, noChildren);
    expect(md).toContain('- one');
    expect(md).toContain('1. first');
    expect(md).toContain('- [x] done');
    expect(md).toContain('- [ ] todo');
  });

  test('code blocks fence with the language and keep raw text', async () => {
    const md = await blocksToMarkdown(
      [block('code', { rich_text: [rt('const x = 1;')], language: 'typescript' })],
      noChildren,
    );
    expect(md).toBe('```typescript\nconst x = 1;\n```');
  });

  test('quote and callout', async () => {
    const md = await blocksToMarkdown(
      [
        block('quote', { rich_text: [rt('wisdom')] }),
        block('callout', { rich_text: [rt('note')], icon: { emoji: '💡' } }),
      ],
      noChildren,
    );
    expect(md).toContain('> wisdom');
    expect(md).toContain('> 💡 note');
  });

  test('nested children are fetched and indented', async () => {
    const parent = block('bulleted_list_item', { rich_text: [rt('parent')] }, { id: 'p1', has_children: true });
    const children: NotionBlock[] = [block('bulleted_list_item', { rich_text: [rt('child')] })];
    const getChildren = async (id: string) => (id === 'p1' ? children : []);
    const md = await blocksToMarkdown([parent], getChildren);
    expect(md).toBe('- parent\n  - child');
  });

  test('an image becomes a markdown image with its url', async () => {
    const md = await blocksToMarkdown(
      [block('image', { external: { url: 'https://img.example/x.png' }, caption: [rt('a cat')] })],
      noChildren,
    );
    expect(md).toBe('![a cat](https://img.example/x.png)');
  });

  test('an unknown block with no rich text is skipped, not crashed', async () => {
    const md = await blocksToMarkdown(
      [block('unsupported_widget', { foo: 1 }), block('paragraph', { rich_text: [rt('after')] })],
      noChildren,
    );
    expect(md).toBe('after');
  });
});

describe('extractTitle', () => {
  test('reads the title property regardless of its name', () => {
    const page = { properties: { Name: { type: 'title', title: [rt('My Page')] } } };
    expect(extractTitle(page)).toBe('My Page');
  });
  test('falls back to Untitled', () => {
    expect(extractTitle({ properties: { Status: { type: 'select' } } })).toBe('Untitled');
  });
});

// A fake Notion backend backed by fixed pages + block maps.
class FakeNotion implements NotionBackend {
  constructor(
    private pages: NotionPageMeta[],
    private blocks: Record<string, NotionBlock[]> = {},
    private childMap: Record<string, NotionBlock[]> = {},
  ) {}
  async listPages(): Promise<NotionPageMeta[]> {
    return this.pages;
  }
  async getBlocks(pageId: string): Promise<NotionBlock[]> {
    return this.blocks[pageId] ?? [];
  }
  async getChildren(blockId: string): Promise<NotionBlock[]> {
    return this.childMap[blockId] ?? [];
  }
}

describe('NotionLeg', () => {
  const repos: string[] = [];
  afterEach(() => {
    while (repos.length) cleanupRepo(repos.pop() as string);
  });

  async function collect(leg: NotionLeg): Promise<SourceObject[]> {
    const out: SourceObject[] = [];
    for await (const o of leg.list()) out.push(o);
    return out;
  }

  test('maps pages to SourceObjects with stable id, title, and converted body', async () => {
    const backend = new FakeNotion(
      [{ id: 'page-1', title: 'Roadmap', lastEditedTime: '2026-07-10T00:00:00.000Z' }],
      { 'page-1': [block('heading_1', { rich_text: [rt('Roadmap')] }), block('paragraph', { rich_text: [rt('Q3 plan')] })] },
    );
    const [obj] = await collect(new NotionLeg({ backend }));
    expect(obj.upstreamId).toBe('page-1');
    expect(obj.title).toBe('Roadmap');
    expect(obj.upstreamMtime).toBe('2026-07-10T00:00:00.000Z');
    expect(obj.body).toContain('# Roadmap');
    expect(obj.body).toContain('Q3 plan');
  });

  test('end-to-end: only shared pages appear, mirrored as markdown under sources/notion', async () => {
    const dir = makeTempRepo();
    repos.push(dir);
    // The fake only returns pages the integration was "shared" — a private page
    // simply never appears in listPages, exactly as Notion search behaves.
    const backend = new FakeNotion(
      [
        { id: 'shared-1', title: 'Shared', lastEditedTime: '2026-07-10T00:00:00.000Z' },
        { id: 'shared-2', title: 'Also Shared', lastEditedTime: '2026-07-11T00:00:00.000Z' },
      ],
      {
        'shared-1': [block('paragraph', { rich_text: [rt('one')] })],
        'shared-2': [block('paragraph', { rich_text: [rt('two')] })],
      },
    );
    const report = await runMirror({ repoRoot: dir, legs: [new NotionLeg({ backend })] }, { dryRun: false });
    expect(report.ok).toBe(true);
    const files = trackedFiles(dir, 'sources');
    expect(files.length).toBe(2);
    expect(files.every(f => f.startsWith('sources/notion/') && f.endsWith('.md'))).toBe(true);
    expect(files.some(f => f.includes('private'))).toBe(false);
  });
});
