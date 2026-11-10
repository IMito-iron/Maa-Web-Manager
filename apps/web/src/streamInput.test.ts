import test from 'node:test';
import assert from 'node:assert/strict';
import {containRect, normalisePoint, PointerTracker, avcCodecString, regionDiff, lowerProfile} from './streamInput';
import type {InputEvent} from './streamInput';

test('containRect letterboxes a 16:9 picture in a square box', () => {
  assert.deepEqual(containRect({left: 0, top: 0, width: 400, height: 400}, 1280, 720), {left: 0, top: 87.5, width: 400, height: 225});
  assert.equal(containRect({left: 0, top: 0, width: 400, height: 400}, 0, 720), null);
});

test('rotated portrait picture maps corners exactly', () => {
  const picture = containRect({left: 10, top: 20, width: 800, height: 450}, 720, 1280)!;
  assert.deepEqual(normalisePoint(picture.left, picture.top, picture, false), {x: 0, y: 0});
  assert.deepEqual(normalisePoint(picture.left + picture.width, picture.top + picture.height, picture, false), {x: 1, y: 1});
  assert.equal(normalisePoint(picture.left - 5, picture.top, picture, false), null);
  assert.deepEqual(normalisePoint(picture.left - 5, picture.top, picture, true), {x: 0, y: 0});
});

test('moves are coalesced but never reordered around down/up', () => {
  const out: InputEvent[] = [];
  const p = new PointerTracker(e => out.push(e));
  p.move(1, .1, .1); // hover: ignored
  p.down(1, .2, .2);
  p.move(1, .3, .3);
  p.move(1, .4, .4);
  p.up(1, .5, .5);
  assert.deepEqual(out.map(e => e.t), ['d', 'm', 'u']);
  assert.deepEqual(out[1], {t: 'm', i: 0, x: .4, y: .4, p: 1});
});

test('multi-touch uses distinct slots and releaseAll lifts every finger', () => {
  const out: InputEvent[] = [];
  const p = new PointerTracker(e => out.push(e));
  p.down(11, .1, .1);
  p.down(12, .9, .9);
  p.move(12, .8, .8);
  p.releaseAll();
  assert.equal(p.active, 0);
  const ups = out.filter(e => e.t === 'u') as {i: number; x: number}[];
  assert.deepEqual(ups.map(u => u.i).sort(), [0, 1]);
  assert.equal(ups.find(u => u.i === 1)!.x, .8);
});

test('cancel is sent as cancel and frees the slot', () => {
  const out: InputEvent[] = [];
  const p = new PointerTracker(e => out.push(e));
  p.down(5, .5, .5);
  p.up(5, .5, .5, true);
  p.down(6, .5, .5);
  assert.deepEqual(out.map(e => e.t), ['d', 'c', 'd']);
  assert.equal((out[2] as any).i, 0);
});

test('at most ten fingers', () => {
  const out: InputEvent[] = [];
  const p = new PointerTracker(e => out.push(e));
  for (let i = 0; i < 12; i++) p.down(i, .5, .5);
  assert.equal(p.active, 10);
});

test('codec string comes from the SPS', () => {
  const au = new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f, 0xac, 0, 0, 0, 1, 0x68, 0xee]);
  assert.equal(avcCodecString(au), 'avc1.64001f');
  assert.equal(avcCodecString(new Uint8Array([0, 0, 1, 0x65, 1, 2, 3])), null);
});

test('regionDiff detects change', () => {
  const a = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
  const b = new Uint8ClampedArray([90, 90, 90, 255, 0, 0, 0, 255]);
  assert.equal(regionDiff(a, a), 0);
  assert.equal(regionDiff(a, b), 45);
});

test('tiers step down to 15 fps and stop there', () => {
  assert.equal(lowerProfile('p60'), 'p30');
  assert.equal(lowerProfile('p30'), 'p15');
  assert.equal(lowerProfile('p15'), null);
});
