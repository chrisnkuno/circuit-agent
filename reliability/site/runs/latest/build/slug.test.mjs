import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from './slug.mjs';

test('slugifies "Hello, World!"', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
});

test('slugifies accented text', () => {
  assert.equal(slugify('Café déjà vu'), 'cafe-deja-vu');
});

test('slugifies "Version 2.0"', () => {
  assert.equal(slugify('Version 2.0'), 'version-2-0');
});

test('collapses repeated separators into one hyphen', () => {
  assert.equal(slugify('A  b---C  d'), 'a-b-c-d');
});

test('empty input yields empty string', () => {
  assert.equal(slugify(''), '');
});

test('slugify is idempotent', () => {
  const inputs = ['Hello, World!', 'Café déjà vu', 'Version 2.0', 'A  b---C', ''];
  for (const input of inputs) {
    const once = slugify(input);
    assert.equal(slugify(once), once);
  }
});
