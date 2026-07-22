/** SHA-256 helpers for the mirror. */
import { createHash } from 'node:crypto';

/** SHA-256 (hex) of a string or buffer — used for original-blob provenance and change detection. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
