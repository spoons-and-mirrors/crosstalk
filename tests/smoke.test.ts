// This live smoke test is intentionally skipped until the new paired-session workflow is wired to a local OpenCode checkout.

import { describe, test } from 'bun:test';

describe.skip('crosstalk live OpenCode smoke test', () => {
  test('creates a buddy on first crosstalk send, wakes it, and exchanges replies', () => {
    // TODO: Rebuild against the new crosstalk tool flow once the local upstream OpenCode SDK path is stable.
  });
});
