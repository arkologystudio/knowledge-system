/**
 * Leg registry.
 *
 * The harness knows nothing about specific sources. Each source leg (Drive,
 * Notion, Obsidian — their own tasks) registers a factory here keyed on a `kind`
 * string; the CLI builds legs from a config file by looking up the kind. The
 * harness ships with no legs registered — it is exercised by a fake leg in tests.
 */
import type { MirrorSource } from './types';

/** A leg's slice of the config file. `kind` selects the factory; the rest is leg-specific. */
export interface LegConfig {
  kind: string;
  [key: string]: unknown;
}

export type LegFactory = (config: LegConfig) => MirrorSource;

const REGISTRY = new Map<string, LegFactory>();

/** Register a leg factory under a `kind`. Called at import time by each leg module. */
export function registerLeg(kind: string, factory: LegFactory): void {
  REGISTRY.set(kind, factory);
}

/** The registered leg kinds, sorted. */
export function availableKinds(): string[] {
  return [...REGISTRY.keys()].sort();
}

/** Build a leg from its config, or throw a clear error naming the available kinds. */
export function buildLeg(config: LegConfig): MirrorSource {
  const factory = REGISTRY.get(config.kind);
  if (!factory) {
    const known = availableKinds().join(', ') || '(none registered)';
    throw new Error(`Unknown source leg kind "${config.kind}". Available: ${known}.`);
  }
  return factory(config);
}
