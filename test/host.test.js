import test from 'node:test';
import assert from 'node:assert/strict';
import { isTestAddress } from '../app/src/host.js';

test('the shared GitHub address is flagged as a test address', () => {
  assert.equal(isTestAddress('someone.github.io'), true);
  assert.equal(isTestAddress('SomeOne.GitHub.io'), true);
  assert.equal(isTestAddress('github.io'), true);
});

test('your own domain, localhost and look-alikes are not', () => {
  assert.equal(isTestAddress('budget.example.com'), false);
  assert.equal(isTestAddress('localhost'), false);
  assert.equal(isTestAddress('github.io.evil.com'), false);
  assert.equal(isTestAddress('notgithub.io'), false);
  assert.equal(isTestAddress(''), false);
});
