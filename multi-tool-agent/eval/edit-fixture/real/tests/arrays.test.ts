import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sum, unique, chunk } from '../src/arrays.js';

test('sum adds all numbers', () => {
  assert.equal(sum([1, 2, 3]), 6);
  assert.equal(sum([]), 0);
});

test('unique removes duplicates and preserves order', () => {
  assert.deepEqual(unique([1, 2, 2, 3]), [1, 2, 3]);
  assert.deepEqual(unique([]), []);
});

test('chunk splits into fixed-size groups', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 2), []);
  assert.throws(() => chunk([1], 0), /size must be > 0/);
});