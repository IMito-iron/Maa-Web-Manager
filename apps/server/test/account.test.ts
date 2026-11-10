import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesAccount, NullAccountProbe} from '../src/account';

test('account matcher matches recognized name or id case-insensitively', () => {
  assert.equal(matchesAccount('博士', {name: '博士', id: '39134123'}), true);
  assert.equal(matchesAccount('博士', {name: 'DrX', id: '39134123'}), false);
  assert.equal(matchesAccount('39134123', {name: null, id: '39134123'}), true);
  assert.equal(matchesAccount('39134123', {name: '博士', id: null}), false);
  assert.equal(matchesAccount('DOCTOR', {name: 'Doctor', id: null}), true);
  assert.equal(matchesAccount(' 博士 ', {name: '博士', id: null}), true);
  assert.equal(matchesAccount('', {name: '博士', id: null}), false);
  assert.equal(matchesAccount('x', {name: null, id: null}), false);
});

test('null probe fails closed', async () => {
  assert.equal(await new NullAccountProbe().currentAccount(), null);
});
