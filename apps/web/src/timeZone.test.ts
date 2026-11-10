import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_TIME_ZONE, serverTimeZone, setServerTimeZone} from './timeZone';

test('the console follows the zone the server reports and ignores invalid values', () => {
  assert.equal(serverTimeZone(), DEFAULT_TIME_ZONE);
  setServerTimeZone('Asia/Tokyo');
  assert.equal(serverTimeZone(), 'Asia/Tokyo');
  for (const bad of ['Mars/Olympus', '', null, 42]) setServerTimeZone(bad);
  assert.equal(serverTimeZone(), 'Asia/Tokyo');
});
