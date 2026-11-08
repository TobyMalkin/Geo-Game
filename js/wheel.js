// Canvas spinner wheel. Pure ES module, no dependencies; importable in Node (no DOM access at import).
//
//   const wheel = createWheel(canvas, { colours });
//   const item = await wheel.spin(items, { rng, durationMs, instant });   // items: [{ id, label }]; instant: land at once, no animation (SCHEMA 4.29)
//
// Geometry: the pointer is fixed at the top. The wheel has a rotation (radians, clockwise, as on a
// canvas). Slice i covers local angles [i*s, (i+1)*s) with s = 2*PI/n, measured clockwise from the
// pointer when rotation is 0. The slice under the pointer is therefore the one containing local
// angle (-rotation) mod 2*PI.
//
// The canvas needs a CSS size (e.g. width/height in a stylesheet). The backing store is sized from
// clientWidth/clientHeight x devicePixelRatio; nothing is drawn while the canvas has no layout size.
//
// spin() resolves with the winning item when the wheel stops. It REJECTS (the UI should catch) when
// setItems() or destroy() is called during the spin, when a spin is already running, when there are no
// items, and after destroy().
//
// The winner is chosen with pickRandom BEFORE the animation, then the wheel eases out and lands so the
// pointer sits inside the winner's slice at a random offset (never on a boundary, never forced to the middle).
//
// Labels (CR-1): slice labels are drawn radially, bold, as large as the slice allows (see labelLayout). On a
// dense wheel (the 193-country wheel) the slices are thin, so on a small canvas only every stride-th slice gets a
// label; while a dense wheel spins, a pill in the middle also shows the name under the pointer in large type, so
// every name can be read as it passes. A wheel created with showResult:false (outline questions) draws no pill,
// and the caller passes blank labels for it.

import { pickRandom } from './state.js';

export const TAU = Math.PI * 2;
/** Landing offsets are kept this fraction away from either slice boundary. */
export const EDGE_MARGIN = 0.1;
export const DEFAULT_DURATION_MS = 4000;
export const REDUCED_DURATION_MS = 0; // prefers-reduced-motion: no rotation animation, the wheel snaps to the result
/** Smallest readable label size in CSS px (bold); below this no labels are drawn. */
export const MIN_LABEL_PX = 9;
/** More slices than this is a "dense" wheel: one-line labels and a live name pill in the middle while spinning. */
export const DENSE_SLICES = 40;
/** Gap between the rim and the end of a label, CSS px. */
export const LABEL_INSET = 8;
/** Largest stride (label every k-th slice) the layout will use before giving up on labels. */
export const MAX_STRIDE = 6;
const CHAR_EM = 0.6; // average width of a bold label glyph, in em (Segoe UI / Arial bold mix)
const FONT_STACK = '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Slice colours; every one has at least 4.5:1 contrast against the white slice labels (tested). */
export const DEFAULT_COLOURS = ['#c0392b', '#2471a3', '#1e8449', '#8a5a0b', '#7d3c98', '#117a8b', '#a04000', '#34495e'];

// ---------------------------------------------------------------------------
// Pure angle maths (exported for tests)
// ---------------------------------------------------------------------------

/** Angle reduced to [0, 2*PI). */
export function normaliseAngle(a) {
  const r = a % TAU;
  let x = r < 0 ? r + TAU : r;
  if (x >= TAU) x = 0; // r + TAU can round up to exactly TAU for tiny negative r
  return x === 0 ? 0 : x; // also turns -0 into 0
}

/** Index of the slice under the pointer when the wheel is rotated by `angle` radians. */
export function sliceAt(angle, n) {
  if (!(n >= 1)) throw new Error('sliceAt needs n >= 1');
  const s = TAU / n;
  const i = Math.floor(normaliseAngle(-angle) / s);
  return Math.min(i, n - 1);
}

/**
 * Rotation that puts the pointer inside slice `index`, at `offset` (0..1) across the slice, after
 * `turns` full turns. The offset is clamped to [EDGE_MARGIN, 1 - EDGE_MARGIN] so the pointer is never
 * on a boundary.
 */
export function targetAngle(index, n, offset = 0.5, turns = 0) {
  if (!(n >= 1) || index < 0 || index >= n) throw new Error('targetAngle: index out of range');
  const o = Math.min(1 - EDGE_MARGIN, Math.max(EDGE_MARGIN, Number.isFinite(offset) ? offset : 0.5));
  const s = TAU / n;
  return turns * TAU - (index + o) * s;
}

/**
 * Rotation to add to `current` so the wheel ends congruent to `target` (mod 2*PI) after at least
 * `minTurns` full extra turns.
 */
export function spinDelta(current, target, minTurns) {
  return normaliseAngle(target - current) + Math.max(0, minTurns) * TAU;
}

export function easeOutCubic(t) {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) ** 3;
}

// ---------------------------------------------------------------------------
// Label layout (pure, exported for tests)
// ---------------------------------------------------------------------------

/** Wheel radius in CSS px for a canvas of the given size (leaves room for the rim and the pointer). */
export function wheelRadius(cssW, cssH) {
  return Math.max(10, Math.min(cssW, cssH - 8) / 2 - 14);
}

/**
 * How the slice labels are laid out for n slices on a wheel of radius r. `longest` is the length in characters of
 * the longest label (after shortening). Labels run along the radius, right-aligned at the rim. Returns
 *   { fontPx, stride, lines, outerR, innerR, maxLen }
 * fontPx 0 means no labels fit. stride k means only slices 0, k, 2k... are labelled. lines is 1 or 2 (two lines
 * only on a sparse wheel). innerR is where the text may begin: far enough out that neighbouring labels do not
 * overlap (the slice is at least as wide as the text block there) and, on a dense wheel, outside the middle pill.
 * The search prefers every slice labelled, then the largest font that leaves room for about `longest` characters.
 */
export function labelLayout(n, r, longest = 12) {
  const none = { fontPx: 0, stride: 1, lines: 1, outerR: 0, innerR: 0, maxLen: 0 };
  if (!(n >= 1) || !(r > 0)) return none;
  const s = TAU / n;
  const outerR = r - LABEL_INSET;
  const dense = n > DENSE_SLICES;
  const rMin = r * (dense ? 0.5 : 0.3);
  const fMax = Math.min(r * 0.09 + 4, 30);
  const want = Math.min(Math.max(1, longest), dense ? 14 : 24);
  const maxLines = dense ? 1 : 2;
  // Room for `want` characters is the aim; on a small dense wheel fewer characters are accepted (longer names
  // are shortened or cut with an ellipsis, and the live pill shows the whole name) before giving up on labels.
  const wants = dense ? [...new Set([want, Math.min(want, 11), Math.min(want, 9)])] : [want];
  for (const w of wants) {
    for (let stride = 1; stride <= Math.min(n, MAX_STRIDE); stride++) {
      let best = null; // the largest font over 1 or 2 lines; one line wins a tie
      for (let lines = 1; lines <= maxLines; lines++) {
        const perLine = lines === 1 ? w : Math.ceil(w / 2) + 2;
        for (let f = fMax; f >= MIN_LABEL_PX; f -= 0.5) {
          const block = f * (0.75 + 0.95 * (lines - 1));
          const innerR = Math.max(block / (stride * s), rMin);
          const maxLen = outerR - innerR;
          if (maxLen >= perLine * f * CHAR_EM) {
            if (!best || f > best.fontPx) best = { fontPx: f, stride, lines, outerR, innerR, maxLen };
            break;
          }
        }
      }
      if (best) return best;
    }
  }
  return none;
}

/** Label font size in px for n slices on a wheel of the given radius, or 0 when labels would be unreadable. */
export function labelFontPx(n, radius, longest = 12) {
  return labelLayout(n, radius, longest).fontPx;
}

const ABBREVIATIONS = [
  [/\bSaint /g, 'St '],
  [/ and the /g, ' & '],
  [/ and /g, ' & '],
  [/\bRepublic\b/g, 'Rep.'],
  [/\bDemocratic\b/g, 'Dem.'],
  [/\bEquatorial\b/g, 'Equat.'],
  [/\bHerzegovina\b/g, 'Herz.'],
];

/** A shorter spelling of a long name for a thin slice ("Saint Kitts and Nevis" -> "St Kitts & Nevis"). */
export function shortenLabel(label) {
  let t = String(label);
  if (t === 'United Arab Emirates') return 'UAE';
  for (const [re, to] of ABBREVIATIONS) t = t.replace(re, to);
  return t;
}

/** Splits a label over two lines at the space nearest the middle; one line when it has no space. */
export function splitLabel(label) {
  const t = String(label);
  const mid = t.length / 2;
  let best = -1;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  }
  return best < 0 ? [t] : [t.slice(0, best), t.slice(best + 1)];
}

/**
 * Decide everything about a spin up front. The winner comes first (pickRandom), then the offset and the
 * number of turns, so a seeded rng reproduces the whole spin.
 * @returns {{ winner, index, offset, turns, from, to }}
 */
export function planSpin(items, currentRotation, rng = Math.random) {
  if (!items || items.length === 0) throw new Error('No items to spin');
  const winner = pickRandom(items, rng);
  const index = items.indexOf(winner);
  const offset = EDGE_MARGIN + rng() * (1 - 2 * EDGE_MARGIN);
  const turns = 4 + Math.floor(rng() * 3); // 4 to 6 full extra turns
  const from = currentRotation;
  const to = from + spinDelta(from, targetAngle(index, items.length, offset, 0), turns);
  return { winner, index, offset, turns, from, to };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function prefersReducedMotion() {
  try {
    return !!(globalThis.matchMedia && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

function sliceColour(colours, i, n) {
  let c = i % colours.length;
  // the last slice must not share a colour with the first
  if (n > 1 && i === n - 1 && c === 0) c = (c + 1) % colours.length;
  return colours[c];
}

export function createWheel(canvas, options = {}) {
  const colours = options.colours && options.colours.length ? options.colours : DEFAULT_COLOURS;
  const showResult = options.showResult !== false;
  const ctx = canvas.getContext('2d');

  let items = [];
  let itemsVersion = 0; // bumped whenever the items change, to rebuild the label cache
  let prepared = null;
  let rotation = 0;
  let result = null; // item shown in the middle once the wheel stops
  let spinning = null; // { reject }
  let rafId = null;
  let destroyed = false;
  let observer = null;
  let cssW = 300;
  let cssH = 300;

  // Sizes the backing store from the CSS (layout) size. Returns false, without touching the canvas,
  // when the canvas has no layout size (hidden screen): canvas.width is in device pixels, so reading it
  // back as a CSS size would multiply the backing store on every draw when devicePixelRatio > 1.
  function measure() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!(w > 0 && h > 0)) return false;
    const dpr = globalThis.devicePixelRatio || 1;
    cssW = w;
    cssH = h;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  // Pill with a name in the middle: the winner once the wheel has stopped, or (live) the name under the
  // pointer while a dense wheel spins, at a fixed width so it does not jump about.
  function drawPill(text, cx, cy, r, live) {
    const maxW = live ? r : r * 1.7;
    let px = Math.max(14, r * (live ? 0.12 : 0.17));
    ctx.font = `bold ${px}px ${FONT_STACK}`;
    while (px > 11 && ctx.measureText(text).width > maxW) {
      px -= 1;
      ctx.font = `bold ${px}px ${FONT_STACK}`;
    }
    const w = (live ? maxW : Math.min(maxW, ctx.measureText(text).width)) + px * 1.4;
    const h = px * 2.2;
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 3;
    ctx.beginPath();
    const x = cx - w / 2;
    const y = cy - h / 2;
    const rad = h / 2;
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#111';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, cy, maxW);
  }

  // Fits text into maxLen px: the full name, else the shortened spelling, else cut with an ellipsis.
  function fitText(text, maxLen) {
    if (ctx.measureText(text).width <= maxLen) return text;
    let t = shortenLabel(text);
    if (ctx.measureText(t).width <= maxLen) return t;
    while (t.length > 1 && ctx.measureText(t).width > maxLen) t = t.slice(0, -2).trimEnd() + '…';
    return t;
  }

  // Layout and fitted label text per slice; rebuilt only when the items, the size or the layout change.
  function prepareLabels(r) {
    const n = items.length;
    const longest = items.reduce((m, it) => Math.max(m, shortenLabel(String(it.label)).length), 0);
    const layout = labelLayout(n, r, longest);
    const key = `${itemsVersion}|${Math.round(r)}|${layout.fontPx}|${layout.stride}|${layout.lines}`;
    if (prepared && prepared.key === key) return prepared;
    const lines = [];
    if (layout.fontPx > 0) {
      ctx.font = `bold ${layout.fontPx}px ${FONT_STACK}`;
      for (let i = 0; i < n; i++) {
        const label = String(items[i].label);
        // every stride-th slice; the last ones are skipped when they would sit closer than a stride to slice 0
        if (i % layout.stride !== 0 || n - i < layout.stride || label === '') { lines.push(null); continue; }
        if (layout.lines === 2 && ctx.measureText(label).width > layout.maxLen) {
          lines.push(splitLabel(shortenLabel(label)).map((l) => fitText(l, layout.maxLen)));
        } else {
          lines.push([fitText(label, layout.maxLen)]);
        }
      }
    }
    prepared = { key, layout, lines };
    return prepared;
  }

  function draw() {
    if (destroyed) return;
    if (!measure()) return; // not laid out yet; the ResizeObserver redraws once it has a size
    ctx.clearRect(0, 0, cssW, cssH);
    const cx = cssW / 2;
    const cy = cssH / 2 + 4;
    const r = wheelRadius(cssW, cssH);
    const n = items.length;

    if (n === 0) {
      ctx.fillStyle = '#ddd';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.fill();
    } else {
      const s = TAU / n;
      const { layout, lines } = prepareLabels(r);
      for (let i = 0; i < n; i++) {
        const a0 = -Math.PI / 2 + rotation + i * s;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, r, a0, a0 + s);
        ctx.closePath();
        ctx.fillStyle = sliceColour(colours, i, n);
        ctx.fill();
        if (n <= 60) {
          ctx.strokeStyle = 'rgba(255,255,255,0.8)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
      if (layout.fontPx > 0) {
        const f = layout.fontPx;
        const step = f * 0.95;
        ctx.font = `bold ${f}px ${FONT_STACK}`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        for (let i = 0; i < n; i++) {
          const ls = lines[i];
          if (!ls) continue;
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(-Math.PI / 2 + rotation + (i + 0.5) * s);
          ls.forEach((text, k) => {
            const y = (k - (ls.length - 1) / 2) * step;
            if (f >= 13) {
              ctx.lineWidth = 3;
              ctx.strokeStyle = 'rgba(0,0,0,0.4)';
              ctx.strokeText(text, layout.outerR, y);
            }
            ctx.fillStyle = '#fff';
            ctx.fillText(text, layout.outerR, y);
          });
          ctx.restore();
        }
      }
    }
    // rim
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#222';
    ctx.stroke();
    // pointer at the top, tip inside the rim
    ctx.beginPath();
    ctx.moveTo(cx - 12, cy - r - 12);
    ctx.lineTo(cx + 12, cy - r - 12);
    ctx.lineTo(cx, cy - r + 14);
    ctx.closePath();
    ctx.fillStyle = '#f1c40f';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#222';
    ctx.stroke();

    if (showResult) {
      if (spinning && n > DENSE_SLICES) drawPill(String(items[sliceAt(rotation, n)].label), cx, cy, r, true);
      else if (result) drawPill(String(result.label), cx, cy, r, false);
    }
  }

  function cancelAnimation() {
    if (rafId !== null && globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame(rafId);
    rafId = null;
  }

  function abortSpin(message) {
    if (!spinning) return;
    const { reject } = spinning;
    spinning = null;
    cancelAnimation();
    reject(new Error(message));
  }

  function setItems(newItems) {
    abortSpin('Wheel items changed during a spin');
    items = Array.isArray(newItems) ? newItems.slice() : [];
    itemsVersion++;
    result = null;
    draw();
  }

  /** Spin and resolve with the winning item once the wheel has stopped. */
  function spin(newItems, opts) {
    opts = opts || {};
    if (destroyed) return Promise.reject(new Error('Wheel destroyed'));
    if (spinning) return Promise.reject(new Error('Wheel is already spinning'));
    if (newItems !== undefined) {
      items = Array.isArray(newItems) ? newItems.slice() : [];
      itemsVersion++;
    }
    result = null;
    if (items.length === 0) {
      draw();
      return Promise.reject(new Error('No items to spin'));
    }
    // reduced motion, or opts.instant (the "Skip the spin" game option, SCHEMA 4.29): same result and same rng, no animation
    const reduced = prefersReducedMotion() || opts.instant === true;
    const duration = reduced ? REDUCED_DURATION_MS : opts.durationMs ?? DEFAULT_DURATION_MS;
    const plan = planSpin(items, rotation, opts.rng || Math.random);
    if (reduced) {
      // no rotation animation at all: show the landed wheel at once
      rotation = plan.to;
      result = plan.winner;
      draw();
      return Promise.resolve(plan.winner);
    }
    const delta = plan.to - plan.from;

    return new Promise((resolve, reject) => {
      spinning = { reject };
      let start = null;
      const tick = (now) => {
        rafId = null;
        if (destroyed || !spinning) return;
        if (start === null) start = now;
        const t = duration > 0 ? Math.min(1, (now - start) / duration) : 1;
        rotation = plan.from + delta * easeOutCubic(t);
        if (t < 1) {
          draw();
          rafId = globalThis.requestAnimationFrame(tick);
        } else {
          rotation = plan.to;
          spinning = null;
          result = plan.winner;
          draw();
          resolve(plan.winner);
        }
      };
      rafId = globalThis.requestAnimationFrame(tick);
    });
  }

  function destroy() {
    abortSpin('Wheel destroyed');
    destroyed = true;
    if (observer) observer.disconnect();
    observer = null;
  }

  if (typeof globalThis.ResizeObserver === 'function') {
    observer = new globalThis.ResizeObserver(() => draw());
    observer.observe(canvas);
  }
  draw();

  return {
    spin,
    setItems,
    destroy,
    /** Current rotation, spinning flag and shown result (for tests and debugging). */
    getState: () => ({ rotation, spinning: !!spinning, result, items: items.slice() }),
  };
}
