import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capitalize, truncate, slugify } from '../src/strings.js';

test('capitalize uppercases the first character', () => {
  assert.equal(capitalize('hello'), 'Hello');
  assert.equal(capitalize(''), '');
});

test('truncate keeps short strings and appends ellipsis', () => {
  assert.equal(truncate('abc', 5), 'abc');
  assert.equal(truncate('abcdef', 3), 'abc…');
  assert.throws(() => truncate('x', -1), /max must be >= 0/);
});

test('slugify lowercases and joins words with dashes', () => {
  assert.equal(slugify('  Hello World  '), 'hello-world');
});