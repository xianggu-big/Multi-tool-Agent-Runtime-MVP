import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, sub, mul, div, clamp } from '../src/calc.js';

test('add returns the arithmetic sum', () => {
  assert.equal(add(2, 3), 5);
});

test('sub returns the difference', () => {
  assert.equal(sub(5, 3), 2);
});

test('mul returns the product', () => {
  assert.equal(mul(4, 3), 12);
});

test('div returns the quotient and rejects zero', () => {
  assert.equal(div(10, 2), 5);
  assert.throws(() => div(1, 0), /divide by zero/);
});

test('clamp keeps n inside [min, max]', () => {
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
  assert.equal(clamp(5, 0, 10), 5);
});