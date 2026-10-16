import type { Recipe } from '../types.ts';
import { LOCAL_EMBED_MAX_BATCH_TOKENS, LOCAL_EMBED_TIMEOUT_MS } from './local-defaults.ts';
import { probeLlamaServer } from '../probes.ts';

/**
 * llama.cpp's `llama-server --embeddings` (also published as
 * `@llama.cpp/llama-server`). Exposes an OpenAI-compatible /v1/embeddings
 * endpoint. Distinct from Ollama: different default port (8080), different
 * model-management story (you launch it with `--model <path>`; the server
 * serves whatever model was passed).
 *
 * Like LiteLLM, this recipe ships with `models: []` because the model
 * identity is whatever the user launched llama-server with. They MUST
 * pass `--embedding-model llama-server:<id>` and `--embedding-dimensions
 * <N>`. The wizard refuses to pick implicit defaults.
 *
 * Reference: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
 */
export const llamaServer: Recipe = {
  id: 'llama-server',
  name: 'llama.cpp llama-server (local)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://localhost:8080/v1',
  auth_env: {
    required: [],
    optional: ['LLAMA_SERVER_BASE_URL', 'LLAMA_SERVER_API_KEY'],
    setup_url:
      'https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md',
  },
  touchpoints: {
    embedding: {
      models: [], // user-driven; whatever model the server was launched with
      user_provided_models: true,
      default_dims: 0, // forces explicit --embedding-dimensions
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-05-10',
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
  /**
   * Probe via the OpenAI-compatible /v1/models endpoint. Caller passes the
   * resolved baseURL (from cfg.base_urls['llama-server'] or env), so the
   * probe agrees with what the gateway will actually call. Falls back to
   * env / localhost:8080 when called without an argument.
   */
  async probe(baseURL?: string) {
    const url = baseURL ?? process.env.LLAMA_SERVER_BASE_URL ?? 'http://localhost:8080/v1';
    const result = await probeLlamaServer(url);
    if (!result.reachable) {
      return {
        ready: false,
        hint: `llama-server not reachable at ${url}. Start it with \`./llama-server --model <path> --embeddings\` or set LLAMA_SERVER_BASE_URL.`,
      };
    }
    if (!result.models_endpoint_valid) {
      return {
        ready: false,
        hint: `llama-server reached but /v1/models returned an unexpected shape: ${result.error ?? 'unknown'}.`,
      };
    }
    return { ready: true };
  },
  setup_hint:
    'Build llama.cpp, then `llama-server --model <gguf-path> --embeddings`. Set --embedding-model llama-server:<id> + --embedding-dimensions <N>.',
};
