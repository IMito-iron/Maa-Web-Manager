// Pure helpers for the streamed Android picture: where the picture sits inside its element, how a
// pointer maps onto it, and how pointer events are turned into an ordered input stream.
//
// Coordinates sent to the media service are normalised to the picture (0..1), so they do not depend
// on the browser's scaling, on letterboxing, or on which capture tier is being watched.

export type Box = {left: number; top: number; width: number; height: number};

/** The rectangle an `object-fit: contain` picture of `w`×`h` occupies inside `box`. */
export function containRect(box: Box, w: number, h: number): Box | null {
  if (!(w > 0 && h > 0 && box.width > 0 && box.height > 0)) return null;
  const scale = Math.min(box.width / w, box.height / h);
  const width = w * scale, height = h * scale;
  return {left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height};
}

/** Normalised picture coordinates for a client point; `clamp` keeps drags that leave the picture. */
export function normalisePoint(x: number, y: number, picture: Box, clamp: boolean): {x: number; y: number} | null {
  let nx = (x - picture.left) / picture.width, ny = (y - picture.top) / picture.height;
  if (!clamp && (nx < 0 || ny < 0 || nx > 1 || ny > 1)) return null;
  nx = Math.min(1, Math.max(0, nx));
  ny = Math.min(1, Math.max(0, ny));
  return {x: nx, y: ny};
}

export type InputEvent =
  | {t: 'd' | 'm' | 'u' | 'c'; i: number; x: number; y: number; p?: number}
  | {t: 'k'; k: 'back' | 'home' | 'apps'}
  | {t: 'hb'};

/**
 * Turns pointer events into the wire stream. Moves are coalesced (only the latest position per
 * finger survives until `flush`), but a down/up/cancel always flushes that finger's pending move
 * first and is emitted immediately, so the order down → moves → up is never violated and no
 * transition is ever dropped. At most ten fingers, matching scrcpy's pointer table.
 */
export class PointerTracker {
  private slots = new Map<number, number>();
  private pending = new Map<number, InputEvent>();
  constructor(private emit: (event: InputEvent) => void) {}

  get active() { return this.slots.size; }

  private slotFor(pointerId: number): number | null {
    const existing = this.slots.get(pointerId);
    if (existing != null) return existing;
    const used = new Set(this.slots.values());
    for (let i = 0; i < 10; i++) if (!used.has(i)) { this.slots.set(pointerId, i); return i; }
    return null;
  }

  private flushSlot(slot: number) {
    const move = this.pending.get(slot);
    if (move) { this.pending.delete(slot); this.emit(move); }
  }

  down(pointerId: number, x: number, y: number, p = 1) {
    if (this.slots.has(pointerId)) return this.move(pointerId, x, y, p);
    const i = this.slotFor(pointerId);
    if (i == null) return;
    this.emit({t: 'd', i, x, y, p});
  }

  move(pointerId: number, x: number, y: number, p = 1) {
    const i = this.slots.get(pointerId);
    if (i == null) return;
    this.pending.set(i, {t: 'm', i, x, y, p});
  }

  up(pointerId: number, x: number, y: number, cancel = false) {
    const i = this.slots.get(pointerId);
    if (i == null) return;
    this.flushSlot(i);
    this.slots.delete(pointerId);
    this.emit({t: cancel ? 'c' : 'u', i, x, y});
  }

  /** Emit the coalesced moves (call once per animation frame). */
  flush() { for (const slot of [...this.pending.keys()]) this.flushSlot(slot); }

  /** Lift every finger where it last was (tab hidden, mode switched, picture lost). */
  releaseAll() {
    for (const [pointerId, i] of [...this.slots]) {
      const last = this.pending.get(i) as {x: number; y: number} | undefined;
      this.pending.delete(i);
      this.slots.delete(pointerId);
      this.emit({t: 'u', i, x: last?.x ?? 0, y: last?.y ?? 0});
    }
  }
}

/** WebCodecs codec string ("avc1.PPCCLL") from the SPS inside an Annex-B access unit. */
export function avcCodecString(au: Uint8Array): string | null {
  for (let i = 0; i + 4 < au.length; i++) {
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1 && (au[i + 3] & 0x1f) === 7 && i + 6 < au.length) {
      const hex = (v: number) => v.toString(16).padStart(2, '0');
      return `avc1.${hex(au[i + 4])}${hex(au[i + 5])}${hex(au[i + 6])}`;
    }
  }
  return null;
}

/** Mean absolute luma-ish difference between two RGBA buffers (0..255). */
export function regionDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  }
  return sum / (a.length / 4) / 3;
}

/** The tier to fall back to when a viewer cannot sustain the current one. */
export function lowerProfile(profile: string): string | null {
  return profile === 'p60' ? 'p30' : profile === 'p30' ? 'p15' : null;
}
