import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../src/calc.js';

test('add returns the arithmetic sum', () => {
  assert.equal(add(2, 3), 5);
});