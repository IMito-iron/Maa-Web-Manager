import test from 'node:test';
import assert from 'node:assert/strict';
import {panelLayout, videoRect} from './vncFit';

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 0.01,
  `${actual} != ${expected}`);
const size = (width: number, height: number) => ({width, height});

/** A black framebuffer with a bright rectangle drawn into it. */
function framed(width: number, height: number, block: {x: number; y: number; width: number; height: number}) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = block.y; y < block.y + block.height; y++) {
    for (let x = block.x; x < block.x + block.width; x++) {
      const offset = (y * width + x) * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 200;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

// The measured reality once: scrcpy drew the phone into 976x549 in the corner of a 1920x1080 canvas.
test('the phone rectangle is measured from the drawn pixels', () => {
  const found = videoRect(framed(200, 120, {x: 0, y: 0, width: 100, height: 56}), 200, 120, size(1280, 720))!;
  assert.ok(found);
  assert.deepEqual(found, {x: 0, y: 0, width: 100, height: 56});
  const middle = videoRect(framed(200, 120, {x: 40, y: 20, width: 100, height: 56}), 200, 120, size(1280, 720))!;
  assert.equal(middle.x, 40);
  assert.equal(middle.y, 20);
});

test('nothing drawn, or an implausible trace, yields no rectangle', () => {
  assert.equal(videoRect(new Uint8ClampedArray(200 * 120 * 4), 200, 120, size(1280, 720)), null);
  // A few stray pixels are not a phone: the measurement must not shrink to them.
  assert.equal(videoRect(framed(200, 120, {x: 2, y: 2, width: 8, height: 4}), 200, 120, size(1280, 720)), null);
  // A block of the wrong shape is not the phone either.
  assert.equal(videoRect(framed(200, 120, {x: 10, y: 10, width: 60, height: 100}), 200, 120, size(1280, 720)), null);
  // Too short a buffer is refused rather than read out of bounds.
  assert.equal(videoRect(new Uint8ClampedArray(16), 200, 120, size(1280, 720)), null);
});

// The box keeps the phone rectangle's aspect, and the RFB target is sized so the rectangle lands on
// the box's origin — the property that keeps noVNC's pointer mapping exact.
test('the layout fills the box with the phone rectangle', () => {
  // The whole canvas: the target is exactly the box, so this degenerates to a plain fit.
  const whole = panelLayout({framebuffer: size(1920, 1080), rect: {x: 0, y: 0, width: 1920, height: 1080},
    available: 972, maxHeight: 900})!;
  near(whole.box.width, 972);
  near(whole.box.height, 546.75);
  near(whole.target.width, 972);
  near(whole.target.height, 546.75);
  near(whole.target.left, 0);
  near(whole.target.top, 0);

  // The measured case: the phone drew into 976x552 of the canvas, so the target grows past the box.
  const cropped = panelLayout({framebuffer: size(1920, 1080), rect: {x: 0, y: 0, width: 976, height: 552},
    available: 586, maxHeight: 900})!;
  near(cropped.box.width, 586);
  near(cropped.box.height, 586 * 552 / 976);
  near(cropped.target.width, 1920 * (586 / 976));
  near(cropped.target.left, 0);

  // A rectangle that is not at the origin is shifted out of view instead.
  const offset = panelLayout({framebuffer: size(1920, 1080), rect: {x: 656, y: 0, width: 608, height: 1080},
    available: 600, maxHeight: 5000})!;
  near(offset.box.height, 600 * 1080 / 608);
  near(offset.target.left, -656 * (600 / 608));
});

// The input invariant: a point p in the box must map to framebuffer coordinate rect.x + p / scale,
// which is what noVNC computes from the canvas's layout box (never from a CSS transform).
test('a point in the box maps to the phone coordinate noVNC will send', () => {
  const layout = panelLayout({framebuffer: size(1920, 1080), rect: {x: 0, y: 0, width: 976, height: 552},
    available: 586, maxHeight: 900})!;
  const scale = layout.box.width / 976;          // css px per framebuffer px
  // noVNC: pos = client - canvasRect.left, then Display.absX divides by the canvas scale.
  const canvasScale = layout.target.width / 1920; // == scale, by construction
  near(canvasScale, scale);
  for (const p of [0, 100, 585]) {
    const client = layout.target.left + p;       // a click at p inside the visible box
    const framebuffer = (client - layout.target.left) / canvasScale;
    near(framebuffer, p / scale);
  }
});

test('unknown sizes yield no layout instead of nonsense', () => {
  for (const view of [
    {framebuffer: null, rect: null, available: 600, maxHeight: 800},
    {framebuffer: size(0, 1080), rect: null, available: 600, maxHeight: 800},
    {framebuffer: size(1920, 1080), rect: null, available: 0, maxHeight: 800},
    {framebuffer: size(1920, 1080), rect: null, available: 600, maxHeight: 0},
  ] as any[]) assert.equal(panelLayout(view), null);
});
