/**
 * Failure notification.
 *
 * A failed run must surface where an operator will actually see it, not as a
 * warning string nobody reads. The harness defines the seam; the concrete
 * channel (a GitHub Actions job failure / an alert) is wired by the runner task.
 */
import type { Notifier } from './types';

/** Default notifier: writes a clearly-marked line to stderr. */
export class ConsoleNotifier implements Notifier {
  failure(legId: string, err: Error): void {
    process.stderr.write(`[source-mirror] LEG FAILED: ${legId}: ${err.message}\n`);
  }
}

/** Collects failures in memory — useful for tests and for a runner that reports at the end. */
export class CollectingNotifier implements Notifier {
  readonly failures: Array<{ legId: string; message: string }> = [];
  failure(legId: string, err: Error): void {
    this.failures.push({ legId, message: err.message });
  }
}
