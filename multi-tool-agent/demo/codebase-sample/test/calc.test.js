import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, sub, mul, div } from '../src/calc.js';
import { capitalize, reverse } from '../src/stringUtils.js';

test('add returns sum', () => assert.equal(add(2, 3), 5));
test('sub returns difference', () => assert.equal(sub(5, 3), 2));
test('mul returns product', () => assert.equal(mul(3, 4), 12));
test('div returns quotient and rejects zero', () => {
  assert.equal(div(10, 2), 5);
  assert.throws(() => div(1, 0));
});
test('capitalize', () => assert.equal(capitalize('hello'), 'Hello'));
test('reverse', () => assert.equal(reverse('abc'), 'cba'));
