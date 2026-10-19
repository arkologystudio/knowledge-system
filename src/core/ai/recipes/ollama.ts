import type { Recipe } from '../types.ts';
import { LOCAL_EMBED_MAX_BATCH_TOKENS, LOCAL_EMBED_TIMEOUT_MS } from './local-defaults.ts';

export const ollama: Recipe = {
  id: 'ollama',
  name: 'Ollama (local)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://localhost:11434/v1',
  auth_env: {
    required: [], // Ollama runs unauthenticated locally; users pass `ollama` as the key.
    optional: ['OLLAMA_BASE_URL', 'OLLAMA_API_KEY'],
    setup_url: 'https://ollama.ai',
  },
  touchpoints: {
    embedding: {
      models: ['nomic-embed-text', 'mxbai-embed-large', 'all-minilm'],
      default_dims: 768, // nomic-embed-text native dim
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-04-20',
      // Not a server-side cap (that depends on the loaded model / launch
      // flags) but a CPU latency budget: without it the gateway sends a
      // whole 100-chunk page of long transcript chunks in one request,
      // which a 4-vCPU box can't finish inside any sane timeout. ~8k tokens
      // keeps one request to well under a minute on CPU. Override with
      // GBRAIN_EMBED_MAX_BATCH_TOKENS.
      max_batch_tokens: LOCAL_EMBED_MAX_BATCH_TOKENS,
      // Local inference: allow slow CPU sub-batches (GBRAIN_AI_EMBED_TIMEOUT_MS wins).
      default_timeout_ms: LOCAL_EMBED_TIMEOUT_MS,
    },
  },
  setup_hint: 'Install Ollama from https://ollama.ai, then `ollama pull nomic-embed-text` and `ollama serve`.',
};
