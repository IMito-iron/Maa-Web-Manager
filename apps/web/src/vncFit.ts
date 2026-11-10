// Measuring what the panel is actually showing.
//
// scrcpy fits the phone video into the X canvas preserving aspect, and the canvas is not
// necessarily covered by it (976x549 inside 1920x1080 was measured once). The panel renders the
// whole framebuffer through noVNC and lets noVNC scale it, because noVNC maps pointer positions
// through its own display transform — any CSS scaling applied outside would send clicks to the
// wrong place. What is left here is the measurement used to report the geometry.
export interface Size {width: number; height: number;}
export interface Rect {x: number; y: number; width: number; height: number;}

const PIXEL_FLOOR = 12;

/**
 * The rectangle the phone occupies inside the framebuffer, measured from the pixels that were
 * actually drawn: anything that is not black belongs to the mirror. Sampled on a 4px grid, and
 * rejected unless it is a substantial share of the framebuffer with a plausible aspect ratio, so a
 * mostly-dark game screen cannot silently shrink it.
 *
 * @param expected the video size, used only to sanity-check the detected aspect ratio
 */
export function videoRect(pixels: ArrayLike<number>, width: number, height: number,
  expected?: Size | null): Rect | null {
  if (!(width > 0 && height > 0) || pixels.length < width * height * 4) return null;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const offset = (y * width + x) * 4;
      if (pixels[offset] > PIXEL_FLOOR || pixels[offset + 1] > PIXEL_FLOOR || pixels[offset + 2] > PIXEL_FLOOR) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const rect: Rect = {x: minX, y: minY, width: Math.min(width - minX, maxX - minX + 4),
    height: Math.min(height - minY, maxY - minY + 4)};
  if (rect.width < width * 0.2 || rect.height < height * 0.2) return null;
  if (expected && expected.width > 0 && expected.height > 0) {
    const aspect = rect.width / rect.height, wanted = expected.width / expected.height;
    if (aspect < wanted * 0.75 || aspect > wanted * 1.3) return null;
  }
  return rect;
}

/**
 * How to place the mirror inside the panel. `box` is what the operator sees; `target` is the
 * container noVNC draws into (the RFB target), sized to `box / f` and shifted so the phone's
 * rectangle lands exactly on the box's origin, where `f` is the phone rectangle's share of the
 * framebuffer.
 *
 * Every value here is a layout property (width/height/left/top) on purpose: noVNC converts pointer
 * positions from the canvas's *layout* box through its own display transform, so scaling applied
 * with a CSS transform would be invisible to it and every click would be off by that factor.
 */
export interface PanelLayout {
  box: {width: number; height: number};
  target: {width: number; height: number; left: number; top: number};
}

/** @returns null when a size is still unknown, so the caller can render a plain 16:9 placeholder. */
export function panelLayout(view: {
  framebuffer: Size | null | undefined;
  rect: Rect | null | undefined;
  available: number;
  maxHeight: number;
}): PanelLayout | null {
  const fw = Number(view.framebuffer?.width), fh = Number(view.framebuffer?.height);
  const {available, maxHeight} = view;
  if (!(fw > 0 && fh > 0 && available > 0 && maxHeight > 0)) return null;
  const rect = view.rect && view.rect.width > 0 && view.rect.height > 0
    ? view.rect : {x: 0, y: 0, width: fw, height: fh};
  const boxWidth = Math.min(available, maxHeight * rect.width / rect.height);
  const boxHeight = boxWidth * rect.height / rect.width;
  const scale = boxWidth / rect.width;                    // css px per framebuffer px
  return {
    box: {width: boxWidth, height: boxHeight},
    target: {width: fw * scale, height: fh * scale, left: -rect.x * scale, top: -rect.y * scale},
  };
}
