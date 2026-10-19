/**
 * Shared embed budgets for local CPU recipes (ollama, llama-server).
 *
 * Local backends have no hosted batch cap, but on CPU every token costs
 * wall-clock: a single request carrying a full page of long chunks can take
 * longer than any HTTP timeout. These budgets make the gateway's existing
 * token-budget pre-split engage so each request stays small.
 */
export const LOCAL_EMBED_MAX_BATCH_TOKENS = 8192;
/** Per-sub-batch embed timeout for local recipes (10 min). */
export const LOCAL_EMBED_TIMEOUT_MS = 600_000;
