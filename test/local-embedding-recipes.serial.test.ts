/**
 * Local CPU embedding recipes (llama-server, ollama) — the defects found moving
 * the Arkology and Octopi brains off hosted embeddings onto llama.cpp.
 *
 *   1. `--embedding-dimensions` was rejected for every value on llama-server
 *      (default_dims 0 + user_provided_models fell through to "this model only
 *      emits its default vector size").
 *   2. diagnoseEmbedding reported `user_provided_model_unset` for
 *      `llama-server:bge-m3` even though the id is right there in the string.
 *   3. Long-document batches never finished on CPU: no token budget, so a whole
 *      100-chunk page went out in one request, and Bun's fetch cut it off at a
 *      hidden 300s regardless of GBRAIN_AI_EMBED_TIMEOUT_MS.
 *
 * Serial: mutates process.env and the gateway's module-level config.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolveSchemaEmbeddingDim, PGVECTOR_COLUMN_MAX_DIMS } from '../src/core/embedding-dim-check.ts';
import {
  configureGateway,
  resetGateway,
  diagnoseEmbedding,
  embed,
  resolveEmbedTimeoutMs,
  resolveEmbedMaxBatchTokens,
  withoutRuntimeFetchTimeout,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import { resolveEmbedBatchSize } from '../src/core/embedding.ts';
import { llamaServer } from '../src/core/ai/recipes/llama-server.ts';
import { ollama } from '../src/core/ai/recipes/ollama.ts';
import { openai } from '../src/core/ai/recipes/openai.ts';
import { LOCAL_EMBED_MAX_BATCH_TOKENS, LOCAL_EMBED_TIMEOUT_MS } from '../src/core/ai/recipes/local-defaults.ts';

const ENV_KEYS = ['GBRAIN_AI_EMBED_TIMEOUT_MS', 'GBRAIN_EMBED_MAX_BATCH_TOKENS', 'GBRAIN_EMBED_BATCH_SIZE'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  resetGateway();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('defect 1: dimension preflight for user-provided-model recipes', () => {
  test('llama-server accepts the dim the operator launched the model with', () => {
    for (const dim of [384, 768, 1024, 4096]) {
      const got = resolveSchemaEmbeddingDim({ embedding_model: 'llama-server:bge-m3', embedding_dimensions: dim });
      expect(got).toEqual({ ok: true, dim, model: 'llama-server:bge-m3', provider: 'llama-server', recipeDefault: 0 });
    }
  });

  test('llama-server without --embedding-dimensions fails with an actionable hint', () => {
    const got = resolveSchemaEmbeddingDim({ embedding_model: 'llama-server:bge-m3' });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toMatch(/--embedding-dimensions/);
  });

  test('llama-server still enforces the pgvector column cap and positivity', () => {
    const big = resolveSchemaEmbeddingDim({ embedding_model: 'llama-server:x', embedding_dimensions: PGVECTOR_COLUMN_MAX_DIMS + 1 });
    expect(big.ok).toBe(false);
    const zero = resolveSchemaEmbeddingDim({ embedding_model: 'llama-server:x', embedding_dimensions: 0 });
    expect(zero.ok).toBe(false);
  });

  test('fixed-model recipes still reject custom dims (no widening)', () => {
    const got = resolveSchemaEmbeddingDim({ embedding_model: 'ollama:nomic-embed-text', embedding_dimensions: 1024 });
    expect(got.ok).toBe(false);
  });
});

describe('defect 2: diagnoseEmbedding reads the model id from the configured string', () => {
  test('llama-server:<id> is ready (no hosted key needed)', () => {
    configureGateway({ embedding_model: 'llama-server:bge-m3', embedding_dimensions: 1024, env: {} });
    const d = diagnoseEmbedding();
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.recipeId).toBe('llama-server');
  });

  test('an explicit override with an id is also ready', () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    const d = diagnoseEmbedding('llama-server:granite-embedding-english-r2');
    expect(d.ok).toBe(true);
  });
});

describe('defect 3: CPU batch budget and timeouts', () => {
  test('local recipes declare a token budget and a long per-batch timeout', () => {
    for (const r of [llamaServer, ollama]) {
      expect(r.touchpoints.embedding?.max_batch_tokens).toBe(LOCAL_EMBED_MAX_BATCH_TOKENS);
      expect(r.touchpoints.embedding?.default_timeout_ms).toBe(LOCAL_EMBED_TIMEOUT_MS);
    }
    // Hosted recipes keep the 60s default timeout.
    expect(openai.touchpoints.embedding?.default_timeout_ms).toBeUndefined();
    expect(resolveEmbedTimeoutMs(openai)).toBe(60_000);
  });

  test('timeout: recipe default applies unless GBRAIN_AI_EMBED_TIMEOUT_MS is set', () => {
    expect(resolveEmbedTimeoutMs(llamaServer)).toBe(LOCAL_EMBED_TIMEOUT_MS);
    // The env value is captured at module load, so setting it now proves the
    // "explicit env wins" branch is taken (it returns the module-level value,
    // not the recipe's).
    process.env.GBRAIN_AI_EMBED_TIMEOUT_MS = '1234';
    expect(resolveEmbedTimeoutMs(llamaServer)).not.toBe(LOCAL_EMBED_TIMEOUT_MS);
  });

  test('GBRAIN_EMBED_MAX_BATCH_TOKENS overrides the recipe budget; junk is ignored', () => {
    expect(resolveEmbedMaxBatchTokens(llamaServer)).toBe(LOCAL_EMBED_MAX_BATCH_TOKENS);
    process.env.GBRAIN_EMBED_MAX_BATCH_TOKENS = '2048';
    expect(resolveEmbedMaxBatchTokens(llamaServer)).toBe(2048);
    expect(resolveEmbedMaxBatchTokens(openai)).toBe(2048); // applies to any recipe
    process.env.GBRAIN_EMBED_MAX_BATCH_TOKENS = 'lots';
    expect(resolveEmbedMaxBatchTokens(llamaServer)).toBe(LOCAL_EMBED_MAX_BATCH_TOKENS);
  });

  test('GBRAIN_EMBED_BATCH_SIZE overrides the embedBatch page size', () => {
    expect(resolveEmbedBatchSize()).toBe(100);
    process.env.GBRAIN_EMBED_BATCH_SIZE = '8';
    expect(resolveEmbedBatchSize()).toBe(8);
    process.env.GBRAIN_EMBED_BATCH_SIZE = '-3';
    expect(resolveEmbedBatchSize()).toBe(100);
  });

  test('a page of long transcript chunks is split into small requests on llama-server', async () => {
    const sizes: number[] = [];
    __setEmbedTransportForTests(async ({ values }: any) => {
      sizes.push(values.length);
      return { embeddings: values.map(() => new Array(1024).fill(0.1)), usage: { tokens: 0 } } as any;
    });
    configureGateway({ embedding_model: 'llama-server:bge-m3', embedding_dimensions: 1024, env: {} });
    // 100 chunks × 6000 chars ≈ 150k tokens: previously ONE request.
    const texts = Array.from({ length: 100 }, (_, i) => `chunk ${i} ` + 'x'.repeat(6000));
    const out = await embed(texts);
    expect(out).toHaveLength(100);
    expect(sizes.length).toBeGreaterThan(1);
    // 8192 × 0.8 safety / 4 chars-per-token ≈ 26k chars → at most 4 chunks a request.
    expect(Math.max(...sizes)).toBeLessThanOrEqual(5);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(100);
  });

  test("Bun's built-in 300s fetch timeout is disabled for the openai-compat embed shim", () => {
    const init = withoutRuntimeFetchTimeout({ method: 'POST', body: '{}' }) as any;
    expect(init.timeout).toBe(false);
    expect(init.method).toBe('POST');
    expect((withoutRuntimeFetchTimeout(undefined) as any).timeout).toBe(false);
  });
});
