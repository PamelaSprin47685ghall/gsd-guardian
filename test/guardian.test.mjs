import { test } from 'node:test';
import assert from 'node:assert';

test('Guardian plugin basic functionality', async (_t) => {
  const mockPi = {
    on: () => {},
    sendMessage: () => {}
  };

  const { default: activate } = await import('../index.js');
  assert.doesNotThrow(() => activate(mockPi));
  console.log('Guardian plugin test passed');
});