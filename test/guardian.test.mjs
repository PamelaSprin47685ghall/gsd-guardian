import { test } from 'node:test';
import assert from 'node:assert';

// Basic test for plugin activation
test('Guardian plugin basic functionality', async (t) => {
  // Mock ExtensionAPI
  const mockPi = {
    on: () => {},
    sendMessage: () => {}
  };

  // Import and activate plugin
  const { default: activate } = await import('../index.js');

  assert.doesNotThrow(() => {
    activate(mockPi);
  });

  console.log('Guardian plugin test passed');
});