// Empire map of the results screen (SCHEMA 4.25, CR-11).
// The first half is pure (no DOM, tested in tests/worldmap.test.js): who owns what, which colour a country gets under
// a filter, which owned countries are too small to see and get a marker, tooltip and label text.
// The second half draws the SVG from data/worldmap.json.
//
// Terms: players = state.js players ({ name, colour, set }); owners = { iso3: playerIndex };
// selected = 'all' or a player index (the filter).

import { colourHex, NEUTRAL_HEX, PANEL_HEX } from './state.js';

/** Countries outside the game's regions (a region-filtered game, SCHEMA 4.26): a dimmer grey than the neutral grey of an unowned country. */
export const OUTSIDE_HEX = '#262b38';

export const FILTER_ALL = 'all';
/** A country narrower than this many screen pixels (its largest piece) also gets a marker when it is owned. */
export const SMALL_PX = 3;
export const MARKER_R_PX = 3.5;      // visible marker radius
export const MARKER_HIT_R_PX = 12;   // invisible hit circle: 24 px across

/** { iso3: playerIndex } for every country in a player's set. */
export function ownerMap(players) {
  const owners = {};
  players.forEach((p, i) => { for (const iso3 of p.set) owners[iso3] = i; });
  return owners;
}

/** True when the filter value is 'all' or a valid player index. */
export function validFilter(selected, players) {
  return selected === FILTER_ALL || (Number.isInteger(selected) && selected >= 0 && selected < players.length);
}

/**
 * The fill of a country: its owner's colour when the filter shows that owner, otherwise the neutral grey
 * (not won, or won by someone the filter hides). A player's colour never depends on the filter.
 * `outside` (optional Set of iso3) are the countries outside the game's regions: the dimmer OUTSIDE_HEX, never owned.
 */
export function fillFor(iso3, owners, players, selected, outside = null) {
  const o = owners[iso3];
  if (o === undefined) return outside && outside.has(iso3) ? OUTSIDE_HEX : NEUTRAL_HEX;
  if (selected !== FILTER_ALL && selected !== o) return NEUTRAL_HEX;
  return colourHex(players[o].colour);
}

/** { iso3: hex } for the given country codes. */
export function fillMap(isoList, owners, players, selected, outside = null) {
  const out = {};
  for (const iso3 of isoList) out[iso3] = fillFor(iso3, owners, players, selected, outside);
  return out;
}

/** True when a piece `sizeUnits` wide on a map `mapWidthUnits` wide, drawn `widthPx` wide, is under SMALL_PX across. */
export function isSmall(sizeUnits, mapWidthUnits, widthPx, minPx = SMALL_PX) {
  return (sizeUnits * widthPx) / mapWidthUnits < minPx;
}

/**
 * Markers for owned countries too small to see at the current width, in the filter's colours. A country the filter
 * hides gets no marker (it is grey, like every unowned country). worldmap = parsed data/worldmap.json.
 * Returns [{ iso3, x, y, hex, owner }] in map units, sorted by iso3 so the order is stable.
 */
export function markersFor(worldmap, owners, players, selected, widthPx) {
  const out = [];
  for (const iso3 of Object.keys(owners).sort()) {
    const c = worldmap.countries[iso3];
    if (!c) continue;
    if (selected !== FILTER_ALL && selected !== owners[iso3]) continue;
    if (!isSmall(c.s, worldmap.width, widthPx)) continue;
    out.push({ iso3, x: c.c[0], y: c.c[1], hex: colourHex(players[owners[iso3]].colour), owner: owners[iso3] });
  }
  return out;
}

/**
 * Tooltip text: "France" and "Owner: Alice" or "Not won" ("Not in this game" for a country outside the chosen regions, CR-15);
 * a third line, the status note ("UN observer state"), only when the country has one (CR-12).
 */
export function tooltipLines(countryName, iso3, owners, players, status, outside = null) {
  const o = owners[iso3];
  const lines = [countryName, o !== undefined ? `Owner: ${players[o].name}` : outside && outside.has(iso3) ? 'Not in this game' : 'Not won'];
  if (status) lines.push(status);
  return lines;
}

/**
 * Accessible name of the map: "World map of empires: Alice 12 countries, Bob 1 country, Cy 0 countries."
 * `scope` (CR-15, e.g. "Europe") adds " Regions in this game: Europe. The other countries are dimmed."
 */
export function mapLabel(players, scope = '') {
  const part = (p) => `${p.name} ${p.set.length} ${p.set.length === 1 ? 'country' : 'countries'}`;
  return `World map of empires: ${players.map(part).join(', ')}.${scope ? ` Regions in this game: ${scope}. The other countries are dimmed.` : ''}`;
}

// ---- zoom and pan (fullscreen only, SCHEMA 4.25) ----
// A view is the part of the map shown: { x, y, w, h } in map units, always the map's aspect ratio, so zoom z = width / w.

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
export const ZOOM_STEP = 1.5;

/** z limited to [min, max]; anything that is not a finite number gives min. */
export function clampZoom(z, min = MIN_ZOOM, max = MAX_ZOOM) {
  return Number.isFinite(z) ? Math.min(max, Math.max(min, z)) : min;
}

/** The whole map. */
export function fullView(width, height) {
  return { x: 0, y: 0, w: width, h: height };
}

/** The zoom of a view on a map `width` units wide (1 = whole map). */
export function viewZoom(view, width) {
  return width / view.w;
}

/** The view moved so it lies inside the map (0..width, 0..height); a view larger than the map becomes the whole map. */
export function clampView(view, width, height) {
  const w = Math.min(view.w, width);
  const h = Math.min(view.h, height);
  return {
    x: Math.min(Math.max(view.x, 0), width - w),
    y: Math.min(Math.max(view.y, 0), height - h),
    w,
    h,
  };
}

/**
 * Zoom by `factor` keeping the map point (cx, cy) at the same place on screen. The zoom is clamped to [min, max] and the
 * result lies inside the map. Zooming out to 1 gives the whole map.
 */
export function zoomAt(view, factor, cx, cy, width, height, min = MIN_ZOOM, max = MAX_ZOOM) {
  const z = clampZoom(viewZoom(view, width) * factor, min, max);
  const w = width / z;
  const h = height / z;
  const fx = (cx - view.x) / view.w;
  const fy = (cy - view.y) / view.h;
  return clampView({ x: cx - fx * w, y: cy - fy * h, w, h }, width, height);
}

/** Pan by (dx, dy) map units, clamped to the map. */
export function panBy(view, dx, dy, width, height) {
  return clampView({ ...view, x: view.x + dx, y: view.y + dy }, width, height);
}

/** SVG viewBox text for a view. */
export function viewBoxOf(view) {
  const r = (n) => Math.round(n * 100) / 100;
  return `${r(view.x)} ${r(view.y)} ${r(view.w)} ${r(view.h)}`;
}

// ---- framing a region filter (SCHEMA 4.26) ----

/** Bounding boxes [minX, minY, maxX, maxY] of every ring of a worldmap path (absolute "M x y", relative "l dx dy ...", "z"). */
export function ringBoxes(d) {
  const out = [];
  for (const part of String(d).split('z')) {
    const m = part.match(/^\s*M(-?\d+)[ ,](-?\d+)(?:l(.*))?$/s);
    if (!m) continue;
    let x = Number(m[1]);
    let y = Number(m[2]);
    const box = [x, y, x, y];
    const nums = (m[3] || '').match(/-?\d+/g) || [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      x += Number(nums[i]);
      y += Number(nums[i + 1]);
      if (x < box[0]) box[0] = x;
      if (y < box[1]) box[1] = y;
      if (x > box[2]) box[2] = x;
      if (y > box[3]) box[3] = y;
    }
    out.push(box);
  }
  return out;
}

/**
 * The part of the map that frames some countries: the bounding box of their land, padded and widened to the map's aspect ratio
 * (so it is an ordinary view, see zoomAt), kept inside the map. Of each country the largest piece and every piece within
 * `near` map units of it count, so a far island (Easter Island, Svalbard, the Azores) does not stretch the frame. A frame wider
 * than `maxShare` of the map (Oceania crosses the 180th meridian) is no use, so the whole map is returned; so it is for an
 * empty list. worldmap = parsed data/worldmap.json.
 */
export function framingView(worldmap, isoList, { pad = 0.06, near = 600, maxShare = 0.9 } = {}) {
  const W = worldmap.width;
  const H = worldmap.height;
  const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
  let box = null;
  for (const iso3 of isoList) {
    const c = worldmap.countries[iso3];
    if (!c) continue;
    const rings = ringBoxes(c.d);
    if (!rings.length) continue;
    const big = rings.reduce((a, b) => (area(b) > area(a) ? b : a));
    for (const b of rings) {
      const dx = Math.max(0, big[0] - b[2], b[0] - big[2]);
      const dy = Math.max(0, big[1] - b[3], b[1] - big[3]);
      if (Math.hypot(dx, dy) > near) continue;
      box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b.slice();
    }
  }
  if (!box) return fullView(W, H);
  const ratio = W / H;
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  let w = (box[2] - box[0]) * (1 + 2 * pad);
  let h = (box[3] - box[1]) * (1 + 2 * pad);
  if (w / h < ratio) w = h * ratio; else h = w / ratio;
  w = Math.max(w, W / MAX_ZOOM);
  if (w > maxShare * W) return fullView(W, H);
  h = w / ratio;
  return clampView({ x: cx - w / 2, y: cy - h / 2, w, h }, W, H);
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/**
 * Draws the map into `container` (replacing its content) and returns
 *   { setFilter(selected), setFullscreen(on), zoomBy(factor), resetZoom(), getZoom(), destroy() }.
 * opts: { worldmap, players, nameOf(iso3), statusOf(iso3), onZoom(z, atHome), outside, frame }.
 * outside = Set of iso3 outside the game's regions (drawn in the dimmer OUTSIDE_HEX); frame = a view (see framingView) the map
 * opens on and returns to on "Reset zoom"; without it the whole map is the home view (CR-15).
 * Normally the SVG fills the container width and keeps the map's aspect ratio. In fullscreen mode (setFullscreen(true)) the
 * container has a fixed size: the SVG is sized to the largest box of the map's aspect ratio that fits (centred, letterboxed)
 * and zoom (buttons through zoomBy, mouse wheel, pinch) and drag-to-pan are switched on. Markers and borders keep their
 * on-screen size at every zoom (non-scaling stroke, marker radius divided by the scale).
 */
export function createEmpireMap(container, { worldmap, players, nameOf, statusOf = () => '', onZoom = () => {}, outside = null, frame = null, scope = '' }) {
  const owners = ownerMap(players);
  const W = worldmap.width;
  const H = worldmap.height;
  let selected = FILTER_ALL;
  const home = frame ? clampView(frame, W, H) : fullView(W, H);
  let view = { ...home };
  let fs = false;
  const outsideSet = outside && outside.size ? outside : null;
  const atHome = () => view.x === home.x && view.y === home.y && view.w === home.w && view.h === home.h;
  container.replaceChildren();
  container.classList.add('map-wrap');
  const svg = svgEl('svg', { viewBox: viewBoxOf(view), role: 'img', 'aria-label': mapLabel(players, scope), class: 'empire-map', preserveAspectRatio: 'xMidYMid meet' });
  const land = svgEl('g', { class: 'land' });
  const other = svgEl('path', { d: worldmap.other, fill: outsideSet ? OUTSIDE_HEX : NEUTRAL_HEX, 'fill-rule': 'evenodd', class: 'other' });
  land.append(other);
  const pathOf = {};
  for (const iso3 of Object.keys(worldmap.countries)) {
    const p = svgEl('path', { d: worldmap.countries[iso3].d, 'fill-rule': 'evenodd', class: 'country', 'data-iso3': iso3, fill: NEUTRAL_HEX });
    pathOf[iso3] = p;
    land.append(p);
  }
  const markerLayer = svgEl('g', { class: 'markers' });
  svg.append(land, markerLayer);
  const tip = document.createElement('div');
  tip.className = 'map-tip';
  tip.hidden = true;
  tip.setAttribute('aria-hidden', 'true');
  container.append(svg, tip);

  function paint() {
    for (const iso3 of Object.keys(pathOf)) pathOf[iso3].setAttribute('fill', fillFor(iso3, owners, players, selected, outsideSet));
  }
  // screen pixels per map unit: the SVG box has the map's aspect ratio, so this is its width over the view width
  function scale() {
    const w = svg.getBoundingClientRect().width || container.clientWidth || 320;
    return w / view.w;
  }
  function drawMarkers() {
    const sc = scale();
    const k = 1 / sc; // map units per screen pixel
    markerLayer.replaceChildren();
    for (const m of markersFor(worldmap, owners, players, selected, sc * W)) {
      const g = svgEl('g', { class: 'marker', 'data-iso3': m.iso3 });
      g.append(
        svgEl('circle', { cx: m.x, cy: m.y, r: MARKER_HIT_R_PX * k, fill: 'transparent', class: 'hit' }),
        svgEl('circle', { cx: m.x, cy: m.y, r: MARKER_R_PX * k, fill: m.hex, stroke: PANEL_HEX, 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke', class: 'dot' }),
      );
      markerLayer.append(g);
    }
  }
  function refresh() { paint(); drawMarkers(); }

  // fullscreen: the largest box of the map's aspect ratio inside the container
  function fitBox() {
    if (!fs) { svg.style.width = ''; svg.style.height = ''; return; }
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (!cw || !ch) return;
    const s = Math.min(cw / W, ch / H);
    svg.style.width = Math.floor(W * s) + 'px';
    svg.style.height = Math.floor(H * s) + 'px';
  }
  function applyView() {
    svg.setAttribute('viewBox', viewBoxOf(view));
    hideTip();
    drawMarkers();
    onZoom(viewZoom(view, W), atHome());
  }
  // map point under a client position
  function toMap(clientX, clientY) {
    const r = svg.getBoundingClientRect();
    return [view.x + ((clientX - r.left) / r.width) * view.w, view.y + ((clientY - r.top) / r.height) * view.h];
  }

  // ---- tooltip: hover with a mouse, tap on a touch screen ----
  let shown = null;
  function hideTip() {
    tip.hidden = true;
    if (shown && pathOf[shown]) pathOf[shown].classList.remove('sel');
    shown = null;
  }
  function showTip(iso3, ev) {
    if (shown && pathOf[shown]) pathOf[shown].classList.remove('sel');
    shown = iso3;
    if (pathOf[iso3]) pathOf[iso3].classList.add('sel');
    const [name, owner, status] = tooltipLines(nameOf(iso3), iso3, owners, players, statusOf(iso3), outsideSet);
    tip.replaceChildren();
    const b = document.createElement('strong');
    b.textContent = name;
    tip.append(b, document.createElement('br'));
    if (status) {
      const note = document.createElement('small');
      note.className = 'status-note';
      note.textContent = status;
      tip.append(note, document.createElement('br'));
    }
    tip.append(owner);
    tip.hidden = false;
    const box = container.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = ev.clientX - box.left + 12;
    let y = ev.clientY - box.top + 14;
    if (x + tw > box.width) x = Math.max(0, ev.clientX - box.left - tw - 12);
    if (y + th > box.height) y = Math.max(0, ev.clientY - box.top - th - 10);
    tip.style.left = Math.max(0, x) + 'px';
    tip.style.top = Math.max(0, y) + 'px';
  }
  const targetIso = (ev) => {
    const t = ev.target && ev.target.closest ? ev.target.closest('[data-iso3]') : null;
    return t ? t.getAttribute('data-iso3') : null;
  };

  // ---- drag to pan, pinch and wheel to zoom (fullscreen only) ----
  const pointers = new Map(); // pointerId -> { x, y }
  let pinchDist = 0;
  let moved = 0;              // pixels travelled since the pointer went down; a click after a drag is not a tap
  function setView(next) {
    if (next.x === view.x && next.y === view.y && next.w === view.w && next.h === view.h) return;
    view = next;
    applyView();
  }
  svg.addEventListener('pointerdown', (ev) => {
    if (!fs) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    moved = 0;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  svg.addEventListener('pointermove', (ev) => {
    if (fs && pointers.has(ev.pointerId)) {
      const prev = pointers.get(ev.pointerId);
      const cur = { x: ev.clientX, y: ev.clientY };
      pointers.set(ev.pointerId, cur);
      moved += Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0 && d > 0) {
          const [cx, cy] = toMap((a.x + b.x) / 2, (a.y + b.y) / 2);
          setView(zoomAt(view, d / pinchDist, cx, cy, W, H));
        }
        pinchDist = d;
        return;
      }
      if (pointers.size === 1 && moved > 4 && viewZoom(view, W) > 1) {
        // keep receiving the drag when the pointer leaves the map (a click afterwards is ignored, see `moved`)
        if (svg.setPointerCapture && !svg.hasPointerCapture(ev.pointerId)) { try { svg.setPointerCapture(ev.pointerId); } catch { /* not capturable */ } }
        const sc = scale();
        setView(panBy(view, -(cur.x - prev.x) / sc, -(cur.y - prev.y) / sc, W, H));
        return;
      }
      if (ev.buttons) return; // a mouse drag does not show tooltips
    }
    if (ev.pointerType !== 'mouse') return;
    const iso3 = targetIso(ev);
    if (iso3) showTip(iso3, ev); else hideTip();
  });
  const endPointer = (ev) => { pointers.delete(ev.pointerId); pinchDist = 0; };
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);
svg.addEventListener('lostpointercapture', endPointer);
  svg.addEventListener('pointerleave', (ev) => { endPointer(ev); if (ev.pointerType === 'mouse') hideTip(); });
  svg.addEventListener('wheel', (ev) => {
    if (!fs) return;
    ev.preventDefault();
    const [cx, cy] = toMap(ev.clientX, ev.clientY);
    setView(zoomAt(view, Math.exp(-ev.deltaY * 0.0015), cx, cy, W, H));
  }, { passive: false });
  svg.addEventListener('click', (ev) => {
    if (moved > 4) { moved = 0; return; } // the end of a drag
    const iso3 = targetIso(ev);
    if (iso3 && !(iso3 === shown && ev.pointerType !== 'mouse' && !tip.hidden)) showTip(iso3, ev); else hideTip();
  });

  let ro = null;
  let lastSig = '';
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => {
      fitBox();
      const sig = Math.round(scale() * 1000) + ':' + container.clientHeight;
      if (sig !== lastSig) { lastSig = sig; drawMarkers(); hideTip(); }
    });
    ro.observe(container);
  }
  refresh();
  lastSig = Math.round(scale() * 1000) + ':' + container.clientHeight;

  return {
    setFilter(next) {
      if (!validFilter(next, players)) return;
      selected = next;
      hideTip();
      refresh();
    },
    /** Switches fullscreen behaviour: fitted box, zoom and pan. Resets the view. Call after the container has its new size. */
    setFullscreen(on) {
      fs = !!on;
      pointers.clear();
      container.classList.toggle('zoomable', fs);
      view = { ...home };
      svg.setAttribute('viewBox', viewBoxOf(view));
      fitBox();
      hideTip();
      drawMarkers();
      onZoom(viewZoom(view, W), true);
    },
    zoomBy(factor) {
      if (!fs) return;
      setView(zoomAt(view, factor, view.x + view.w / 2, view.y + view.h / 2, W, H));
    },
    resetZoom() {
      if (!fs) return;
      setView({ ...home });
    },
    getZoom() { return viewZoom(view, W); },
    atHome,
    destroy() { if (ro) ro.disconnect(); container.replaceChildren(); },
  };
}
