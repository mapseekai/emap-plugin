import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from 'cordis';
import { __SERVICE__Plugin } from '../dist/index.js';
test('native provider installs, restarts and disposes', async () => {
  const ctx = new Context(), fiber = ctx.plugin(__SERVICE__Plugin());
  await fiber.await();
  const first = ctx.__SERVICE__;
  assert.equal(first.ready, true);
  await fiber.restart(); await fiber.await();
  assert.notEqual(ctx.__SERVICE__, first);
  await fiber.dispose();
});
