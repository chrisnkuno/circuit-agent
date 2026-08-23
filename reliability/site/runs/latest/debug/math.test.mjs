import test from 'node:test'; import assert from 'node:assert/strict'; import { multiply } from './math.mjs'; test('multiplies', () => assert.equal(multiply(6, 7), 42));
