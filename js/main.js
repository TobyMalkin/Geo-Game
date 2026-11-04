// Geo Game UI: screen flow and event wiring. All game rules live in state.js / answer.js; this file
// only renders state and forwards events.
//
// Turn stages (derived, never stored): category -> country -> question -> reveal.
//   turn   = null | { categoryId, iso3? }   category (and country) already spun this turn
//   reveal = null | { correct, expectedText, given, overruled? }   answer already checked and applied to the state;
//                      correct is the result in force, overruled is true when the players flipped the automatic check
//                      Display mode (SCHEMA 4.24): correct is null until the players mark Correct or Wrong (nothing is
//                      scored before that); given is always empty and overruled is false.
//
// Developer hooks (harmless in play, used by the headless playtest):
//   ?fast                       short wheel animation and no pause after landing
//   globalThis.__geoForce       { category: 'outline', country: 'MLT' } makes the next spin land there

import {
  createGame, availableCategories, eligibleCountries, applyResult, overrideResult, setVote, nextPlayer,
  isGameOver, endReason, ranking, gameMode, validMode, applyDisplayResult, canContinue, MODE_TYPE, MODE_DISPLAY,
  PALETTE, colourOf, colourHex, randomColours, randomUnusedColour, changeColour, isColourTaken, fillColours,
} from './state.js';
import { createEmpireMap, FILTER_ALL, MAX_ZOOM, MIN_ZOOM, ZOOM_STEP } from './worldmap.js';
import { createWheel } from './wheel.js';
import { checkAnswer, parseNumber, parseColours } from './answer.js';
import {
  buildQuestion, questionLabel, formatExpected, listAnd, firstBlank, imageItems, alsoAccepted, militaryNeighbours, displayHint, displayPrompt, statusNote,
} from './questions.js';

const SAVE_KEY = 'geogame.save.v1';
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
const FAST = new URLSearchParams(location.search).has('fast');
const LANDING_PAUSE_MS = FAST ? 0 : 1100;

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined) e.append(kid);
  return e;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function announce(message) {
  const live = $('live');
  live.textContent = '';
  setTimeout(() => { live.textContent = message; }, 60);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let countries = null;
let categories = null;
let catById = {};

let game = null;      // state.js game state
let turn = null;
let reveal = null;
let busy = false;     // a wheel is spinning
let gameToken = 0;    // bumped whenever a game starts or is abandoned, so late async work can bail out
let lastNames = null;
let setupNames = ['', ''];
let lastColours = null;
let setupColours = randomColours(2); // colour id per setup row, never shared (SCHEMA 4.25)
let openPicker = null;               // index of the setup row whose colour picker is open
let setupMode = MODE_TYPE; // the answer mode ticked on the setup screen; remembered between games
let catWheel = null;
let countryWheel = null;
let countryWheelHidden = null;
let shownOutlineUrl = null;
let builtQuestionKey = null;
const outlineCache = new Map();
let worldmapPromise = null;  // data/worldmap.json, fetched once
let empireMap = null;        // the drawn results map, { setFilter, destroy }
let mapFilter = FILTER_ALL;  // 'all' or a player index
let empiresToken = 0;
let fsMode = null;           // null | 'native' (Fullscreen API) | 'overlay' (fixed full-viewport fallback)
const openDetails = new Set();

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function saveGame() {
  if (!game) return;
  try {
    const { countries: _omit, ...rest } = game;
    localStorage.setItem(SAVE_KEY, JSON.stringify({ v: 1, game: rest, turn, reveal }));
  } catch { /* storage unavailable or full: playing still works */ }
}

function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
}

const isStr = (v) => typeof v === 'string';

// Checks the saved reveal has exactly the shape renderReveal reads.
function validReveal(rv, display) {
  // correct: null is a display-mode reveal that has not been marked yet
  return !!rv && typeof rv === 'object' && (typeof rv.correct === 'boolean' || (display && rv.correct === null)) && isStr(rv.expectedText)
    && Array.isArray(rv.given) && rv.given.every(isStr)
    && (rv.overruled === undefined || typeof rv.overruled === 'boolean');
}

// Returns { game, turn, reveal } for a usable save, otherwise null. Never throws.
function parseSave(raw) {
  try {
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object' || d.v !== 1 || !d.game || typeof d.game !== 'object') return null;
    const g = { ...d.game, countries };
    if (!validMode(g.mode)) return null;
    g.mode = gameMode(g); // a save from before CR-10 has no mode and loads as 'type'
    if (!Array.isArray(g.players)) return null;
    const n = g.players.length;
    if (n < MIN_PLAYERS || n > MAX_PLAYERS) return null;
    if (g.phase !== 'playing' && g.phase !== 'ended') return null;
    if (!Number.isInteger(g.currentPlayer) || g.currentPlayer < 0 || g.currentPlayer >= n) return null;
    if (!Number.isInteger(g.round) || g.round < 1) return null;
    // Own-key lookups only: a saved id such as "constructor" must not match an inherited property.
    const isCountry = (c) => isStr(c) && Object.hasOwn(countries, c);
    const isCategory = (c) => isStr(c) && Object.hasOwn(catById, c);
    if (!Array.isArray(g.pool) || !g.pool.every(isCountry)) return null;
    const owned = new Set(g.pool);
    if (owned.size !== g.pool.length) return null;
    for (const p of g.players) {
      if (!p || typeof p !== 'object' || !isStr(p.name) || p.name === '') return null;
      if (typeof p.voteEnd !== 'boolean') return null;
      if (!Array.isArray(p.set) || !Array.isArray(p.remainingCategories)) return null;
      if (!p.set.every(isCountry)) return null;
      // Each country is in exactly one place: the pool or one player's set.
      for (const c of p.set) {
        if (owned.has(c)) return null;
        owned.add(c);
      }
      if (!p.remainingCategories.every(isCategory)) return null;
      if (new Set(p.remainingCategories).size !== p.remainingCategories.length) return null;
    }
    // Colours (SCHEMA 4.25): a save from before CR-11 has none and gets them in palette order; a bad or repeated one is replaced.
    const cols = fillColours(g.players.map((p) => p.colour), n);
    g.players = g.players.map((p, i) => ({ ...p, colour: cols[i] }));
    let t = d.turn || null;
    const rv = d.reveal || null;
    if (t) {
      if (typeof t !== 'object' || !isCategory(t.categoryId)) return null;
      if (t.iso3 !== undefined) {
        if (!isCountry(t.iso3) || countries[t.iso3][t.categoryId] == null) return null;
        if (!rv && !g.pool.includes(t.iso3)) return null;
      }
    }
    const current = g.players[g.currentPlayer];
    if (rv) {
      // A reveal belongs to the answer just given: the category is used up, and a correct answer
      // moved the country into the current player's set. A game that ended on that answer
      // (phase 'ended') is saved too, so a reload on the final reveal can still show it.
      if (!validReveal(rv, g.mode === MODE_DISPLAY) || !(t && t.iso3)) return null;
      if (rv.correct === null) {
        // display mode, answer shown but not marked yet: nothing is scored, so the turn is still open
        if (g.phase !== 'playing' || isGameOver(g)) return null;
        if (!current.remainingCategories.includes(t.categoryId) || !g.pool.includes(t.iso3)) return null;
      } else {
        if (current.remainingCategories.includes(t.categoryId)) return null;
        if (rv.correct !== current.set.includes(t.iso3)) return null;
        if (g.phase === 'ended' && !Object.hasOwn(END_TEXT, g.endReason)) return null;
      }
    } else {
      if (g.phase !== 'playing' || isGameOver(g)) return null;
      if (t && !current.remainingCategories.includes(t.categoryId)) t = null;
      // A turn needs a country to spin for: a saved category with none left in the pool is unusable.
      if (t && eligibleCountries(g, t.categoryId).length === 0) return null;
    }
    return { game: g, turn: t, reveal: rv };
  } catch {
    return null;
  }
}

// The saved game if there is a usable one. A save that is present but unusable (corrupt, old, stale)
// is removed so it does not keep offering a broken resume.
function loadSave() {
  let raw = null;
  try { raw = localStorage.getItem(SAVE_KEY); } catch { return null; }
  if (!raw) return null;
  const saved = parseSave(raw);
  if (!saved) clearSave();
  return saved;
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function showScreen(name) {
  for (const s of ['setup', 'game', 'results']) $('screen-' + s).hidden = s !== name;
  document.body.classList.toggle('results-wide', name === 'results'); // Amendment 4: header and results panel as wide as the map band
  $('btn-new-game').hidden = name === 'setup';
  if (name !== 'game') $('mode-label').hidden = true;
}

function focusSoon(node) {
  if (node) setTimeout(() => node.focus(), 0);
}

// ---------------------------------------------------------------------------
// Setup screen
// ---------------------------------------------------------------------------

// A country in a list of won countries: its name and, for PSE, VAT, TWN and XKX, the small status note (CR-12).
function countryItem(iso3) {
  const c = countries[iso3];
  const note = statusNote(c);
  return el('li', {}, c.name, note ? el('small', { class: 'status-note', text: ` · ${note}` }) : null);
}

function swatch(colourId, extra = '') {
  return el('span', { class: 'swatch' + extra, style: `background:${colourHex(colourId)}`, 'aria-hidden': 'true' });
}

// The colour picker of one setup row: a radio group of the 8 colours, colours held by another row disabled and marked taken.
function colourPicker(i) {
  const group = el('div', { class: 'colour-picker', id: `colour-picker-${i}`, role: 'radiogroup', 'aria-label': `Colour for Player ${i + 1}` });
  for (const c of PALETTE) {
    const taken = isColourTaken(setupColours, c.id, i);
    const input = el('input', { type: 'radio', name: `colour-${i}`, value: c.id, disabled: taken });
    input.checked = setupColours[i] === c.id;
    input.addEventListener('click', (ev) => {
      const next = changeColour(setupColours, i, c.id);
      if (next === setupColours) return;
      setupColours = next;
      // a mouse or touch choice closes the picker; keyboard arrows keep it open so the choice can be browsed
      const pointer = ev.detail > 0;
      if (pointer) openPicker = null;
      renderSetup(null, pointer ? `colour-btn-${i}` : null, pointer ? null : { row: i, value: c.id });
      announce(`Player ${i + 1} colour: ${c.name}`);
    });
    group.append(el('label', { class: 'chip' + (taken ? ' taken' : '') + (setupColours[i] === c.id ? ' on' : '') },
      input, swatch(c.id), el('span', { class: 'chip-name', text: taken ? `${c.name} (taken)` : c.name })));
  }
  const done = el('button', { type: 'button', class: 'btn secondary chip-done', text: 'Done' });
  done.addEventListener('click', () => { openPicker = null; renderSetup(null, `colour-btn-${i}`); });
  group.append(done);
  group.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); openPicker = null; renderSetup(null, `colour-btn-${i}`); }
  });
  return group;
}

function renderSetup(focusIndex = null, focusId = null, focusRadio = null) {
  const wrap = $('player-fields');
  wrap.replaceChildren();
  setupNames.forEach((name, i) => {
    const id = `player-name-${i}`;
    const input = el('input', {
      type: 'text', id, maxlength: '20', autocomplete: 'off', value: name,
      placeholder: `Player ${i + 1}`, 'aria-describedby': 'setup-error',
    });
    input.addEventListener('input', () => {
      setupNames[i] = input.value;
      $('setup-error').textContent = '';
    });
    const c = colourOf(setupColours[i]);
    const open = openPicker === i;
    const cbtn = el('button', {
      type: 'button', class: 'colour-btn', id: `colour-btn-${i}`, 'aria-label': `Colour for Player ${i + 1}: ${c.name}`,
      'aria-expanded': String(open), 'aria-controls': `colour-picker-${i}`,
    }, swatch(c.id, ' big'), el('span', { class: 'caret', 'aria-hidden': 'true', text: '\u25be' }));
    cbtn.addEventListener('click', () => {
      openPicker = openPicker === i ? null : i;
      renderSetup(null, `colour-btn-${i}`);
    });
    const kids = [el('div', { class: 'grow' }, input)];
    if (setupNames.length > MIN_PLAYERS) {
      const rm = el('button', { type: 'button', class: 'btn secondary', 'aria-label': `Remove player ${i + 1}`, text: 'Remove' });
      rm.addEventListener('click', () => {
        setupNames.splice(i, 1);
        setupColours.splice(i, 1); // frees the colour
        openPicker = null;
        renderSetup(Math.min(i, setupNames.length - 1));
        announce(`Player ${i + 1} removed`);
      });
      kids.push(rm);
    }
    wrap.append(el('div', { class: 'field' }, el('label', { for: id, text: `Player ${i + 1} name` }), el('div', { class: 'field-row' }, cbtn, kids), open ? colourPicker(i) : null));
  });
  $('btn-add-player').disabled = setupNames.length >= MAX_PLAYERS;
  $('mode-type').checked = setupMode !== MODE_DISPLAY;
  $('mode-display').checked = setupMode === MODE_DISPLAY;
  if (focusIndex !== null) focusSoon($(`player-name-${focusIndex}`));
  if (focusId) focusSoon($(focusId));
  if (focusRadio) {
    const r = document.querySelector(`#colour-picker-${focusRadio.row} input[value="${focusRadio.value}"]`);
    if (r) focusSoon(r);
  }
}

function renderResumeBox() {
  const saved = loadSave();
  const box = $('resume-box');
  if (!saved) { box.hidden = true; return; }
  const names = saved.game.players.map((p) => p.name).join(', ');
  $('resume-text').textContent = `A game is in progress: ${names} (round ${saved.game.round}).`;
  box.hidden = false;
}

function goToSetup() {
  gameToken++;
  game = null;
  turn = null;
  reveal = null;
  busy = false;
  builtQuestionKey = null;
  setupNames = lastNames ? lastNames.slice() : ['', ''];
  setupColours = lastColours && lastNames && lastColours.length === lastNames.length ? lastColours.slice() : randomColours(setupNames.length);
  openPicker = null;
  $('setup-error').textContent = '';
  renderSetup();
  renderResumeBox();
  showScreen('setup');
  focusSoon($('setup-title'));
}

let submitting = false;

async function onSetupSubmit(e) {
  e.preventDefault();
  if (submitting) return;
  const names = setupNames.map((n, i) => n.trim() || `Player ${i + 1}`);
  const seen = new Set();
  for (let i = 0; i < names.length; i++) {
    const key = names[i].toLowerCase();
    if (seen.has(key)) {
      $('setup-error').textContent = 'Each player needs a different name.';
      focusSoon($(`player-name-${i}`));
      return;
    }
    seen.add(key);
  }
  const mode = $('mode-display').checked ? MODE_DISPLAY : MODE_TYPE;
  // Starting overwrites the saved game, so ask first when there is a usable one.
  if (loadSave()) {
    submitting = true;
    let ok = false;
    try {
      ok = await confirmDialog('Replace the saved game?', 'A game is already saved. Starting a new game will delete it.', 'Replace it', 'Keep saved game');
    } finally {
      submitting = false;
    }
    if (!ok) { focusSoon($('btn-start')); return; }
  }
  startGame(names, mode, setupColours.slice());
}

function startGame(names, mode = MODE_TYPE, colours = undefined) {
  gameToken++;
  lastNames = names.slice();
  setupMode = mode;
  game = createGame(names, countries, categories, mode, colours);
  lastColours = game.players.map((p) => p.colour);
  turn = null;
  reveal = null;
  busy = false;
  builtQuestionKey = null;
  openDetails.clear();
  saveGame();
  showScreen('game');
  renderGame();
  renderPlayers();
  prefetchWorldMap();
}

function resumeSaved() {
  const saved = loadSave();
  if (!saved) { renderResumeBox(); return; }
  try {
    gameToken++;
    game = saved.game;
    turn = saved.turn;
    reveal = saved.reveal;
    busy = false;
    builtQuestionKey = null;
    openDetails.clear();
    showScreen('game');
    renderGame();
    renderPlayers();
    lastNames = game.players.map((p) => p.name);
    lastColours = game.players.map((p) => p.colour);
    setupMode = gameMode(game);
    prefetchWorldMap();
  } catch (err) {
    // Any failure: drop the save and return to setup, so the game screen is never left half-drawn.
    console.error('Could not resume the saved game', err);
    clearSave();
    goToSetup();
    $('setup-error').textContent = 'The saved game could not be loaded, so it was removed. Please start a new game.';
  }
}

// ---------------------------------------------------------------------------
// Game screen
// ---------------------------------------------------------------------------

function stage() {
  if (reveal) return 'reveal';
  if (turn && turn.iso3) return 'question';
  if (turn && turn.categoryId) return 'country';
  return 'category';
}

function categoryItems() {
  return availableCategories(game, game.currentPlayer).map((id) => ({ id, label: catById[id].label }));
}

function countryItems(cat) {
  const hide = cat.type === 'outline';
  return eligibleCountries(game, cat.id).map((iso3) => ({ id: iso3, label: hide ? '' : countries[iso3].name }));
}

function getCountryWheel(hideNames) {
  if (!countryWheel || countryWheelHidden !== hideNames) {
    if (countryWheel) countryWheel.destroy();
    // outline: no centre label (showResult false) and blank slice labels (see countryItems)
    countryWheel = createWheel($('canvas-country'), { showResult: !hideNames });
    countryWheelHidden = hideNames;
  }
  return countryWheel;
}

function renderGame({ focus = true } = {}) {
  const p = game.players[game.currentPlayer];
  const st = stage();
  const left = availableCategories(game, game.currentPlayer).length;
  const display = gameMode(game) === MODE_DISPLAY;
  $('mode-label').textContent = display ? 'Display mode' : 'Type mode';
  $('mode-label').hidden = false;
  $('turn-title').replaceChildren(swatch(p.colour, ' lead'), `${p.name}'s turn`);
  $('turn-sub').textContent = `Round ${game.round} · ${plural(p.set.length, 'country', 'countries')} won · ${plural(left, 'category', 'categories')} left`;

  const spinning = st === 'category' || st === 'country';
  $('panel-spin').hidden = !spinning;
  $('panel-question').hidden = !(st === 'question' || st === 'reveal');
  $('panel-reveal').hidden = st !== 'reveal';

  if (st === 'category') {
    const items = categoryItems();
    $('wrap-cat').hidden = false;
    $('wrap-country').hidden = true;
    $('spin-category').hidden = true;
    $('spin-category').replaceChildren();
    $('btn-spin').removeAttribute('aria-describedby');
    catWheel.setItems(items);
    $('spin-status').textContent = `${plural(items.length, 'category', 'categories')} to spin for.`;
    $('btn-spin').textContent = 'Spin the category wheel';
    $('btn-spin').disabled = busy;
    if (focus) focusSoon($('btn-spin'));
  } else if (st === 'country') {
    const cat = catById[turn.categoryId];
    const hide = cat.type === 'outline';
    const items = countryItems(cat);
    $('wrap-cat').hidden = true;
    $('wrap-country').hidden = false;
    getCountryWheel(hide).setItems(items);
    // CR-14: the chosen category stays above the country wheel until the question appears (also after a resume).
    // It is static text; the button is described by it, so a screen reader hears it with "Spin the country wheel".
    $('spin-category').replaceChildren('Category: ', el('strong', { text: cat.label }));
    $('spin-category').hidden = false;
    $('btn-spin').setAttribute('aria-describedby', 'spin-category');
    $('spin-status').textContent = `${plural(items.length, 'country', 'countries')} to spin for.`;
    $('btn-spin').textContent = 'Spin the country wheel';
    $('btn-spin').disabled = busy;
    $('q-error').textContent = '';
    if (focus) focusSoon($('btn-spin'));
  } else {
    renderQuestion(st === 'reveal');
    if (st === 'reveal') renderReveal(focus);
    else if (focus) focusSoon(display ? $('btn-submit') : $('q-inputs').querySelector('input'));
  }
}

// ---- spinning ----

function rngFor(items, kind) {
  const forced = globalThis.__geoForce && globalThis.__geoForce[kind];
  const idx = forced ? items.findIndex((i) => i.id === forced) : -1;
  if (idx < 0) return Math.random;
  delete globalThis.__geoForce[kind];
  let first = true;
  return () => {
    if (first) { first = false; return (idx + 0.5) / items.length; }
    return Math.random();
  };
}

async function onSpin() {
  if (busy || !game) return;
  const token = gameToken;
  const st = stage();
  if (st !== 'category' && st !== 'country') return;
  busy = true;
  let failed = false;
  // Move focus to the status line before the button is disabled, so focus does not fall to the page.
  $('spin-status').textContent = 'Spinning...';
  $('spin-status').focus();
  $('btn-spin').disabled = true;
  const opts = (items, kind) => ({ rng: rngFor(items, kind), durationMs: FAST ? 40 : undefined });
  try {
    if (st === 'category') {
      const items = categoryItems();
      const item = await catWheel.spin(items, opts(items, 'category'));
      if (token !== gameToken) return;
      turn = { categoryId: item.id };
      $('spin-status').textContent = `Landed on: ${item.label}`;
      announce(`Category: ${item.label}`);
    } else {
      const cat = catById[turn.categoryId];
      const hide = cat.type === 'outline';
      const items = countryItems(cat);
      const item = await getCountryWheel(hide).spin(items, opts(items, 'country'));
      if (token !== gameToken) return;
      turn = { categoryId: cat.id, iso3: item.id };
      builtQuestionKey = null;
      if (hide) {
        $('spin-status').textContent = 'A country has been chosen.';
        announce('A country has been chosen. Its outline is shown next.');
      } else {
        $('spin-status').textContent = `Landed on: ${countries[item.id].name}`;
        announce(`Country: ${countries[item.id].name}`);
      }
    }
    saveGame();
    if (LANDING_PAUSE_MS) await wait(LANDING_PAUSE_MS);
    if (token !== gameToken) return;
  } catch (err) {
    if (token !== gameToken) return; // wheel aborted (game abandoned): nothing to do
    console.error('Spin failed', err);
    failed = true;
  } finally {
    if (token === gameToken) busy = false;
  }
  renderGame();
  if (failed) {
    const msg = 'Something went wrong with the wheel. Please press the spin button to try again.';
    $('spin-status').textContent = msg;
    announce(msg);
  }
}

// ---- question ----

async function loadOutline(url) {
  if (!outlineCache.has(url)) outlineCache.set(url, fetchJson(url).catch((e) => { outlineCache.delete(url); throw e; }));
  return outlineCache.get(url);
}

async function showOutline(url) {
  const box = $('q-outline');
  box.hidden = false;
  if (shownOutlineUrl === url && box.querySelector('svg')) return;
  shownOutlineUrl = url;
  box.replaceChildren(el('p', { class: 'muted', text: 'Loading outline...' }));
  try {
    const data = await loadOutline(url);
    if (shownOutlineUrl !== url) return;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', data.viewBox);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Outline of the mystery country');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', data.d);
    path.setAttribute('fill-rule', 'evenodd');
    svg.append(path);
    box.replaceChildren(svg);
  } catch {
    if (shownOutlineUrl !== url) return;
    const retry = el('button', { type: 'button', class: 'btn secondary', text: 'Try again' });
    retry.addEventListener('click', () => { shownOutlineUrl = null; showOutline(url); });
    box.replaceChildren(el('p', { class: 'error', text: 'Could not load the outline.' }), retry);
  }
}

function renderQuestion(readOnly) {
  const cat = catById[turn.categoryId];
  const q = buildQuestion(cat, turn.iso3, countries);
  const meta = $('q-meta');
  meta.replaceChildren();
  if (q.showCountry) {
    const c = countries[turn.iso3];
    meta.append('Country: ', el('strong', { text: c.name }), ` · Category: ${q.label}`);
  } else {
    meta.append(`Category: ${q.label}`);
  }
  // CR-12: the status note under the country name (not on the outline question, where the country must stay hidden)
  const qStatus = $('q-status');
  qStatus.textContent = q.showCountry ? statusNote(countries[turn.iso3]) : '';
  qStatus.hidden = !qStatus.textContent;
  $('q-prompt').textContent = gameMode(game) === MODE_DISPLAY ? displayPrompt(cat, q.prompt) : q.prompt;

  if (q.outlineUrl) showOutline(q.outlineUrl);
  else { $('q-outline').hidden = true; $('q-outline').replaceChildren(); shownOutlineUrl = null; }

  const display = gameMode(game) === MODE_DISPLAY;
  $('answer-form').hidden = readOnly;
  // display mode: no answer boxes, no typing hint, no error line; the form is just the "Show answer" button.
  // The category rule hints (displayHint) stay, and the prompt loses the sentence about answer boxes (displayPrompt).
  $('btn-submit').textContent = display ? 'Show answer' : 'Submit answer';
  $('q-error').hidden = display;
  const key = `${turn.categoryId}:${turn.iso3}`;
  if (builtQuestionKey !== key) {
    builtQuestionKey = key;
    $('q-error').textContent = '';
    $('q-hint').textContent = display ? displayHint(cat) : q.hint;
    $('q-hint').hidden = display && !displayHint(cat);
    const box = $('q-inputs');
    box.replaceChildren();
    for (const inp of display ? [] : q.inputs) {
      const input = el('input', {
        type: 'text', id: inp.id, inputmode: inp.inputMode, autocomplete: 'off', autocapitalize: 'off',
        spellcheck: 'false', 'aria-describedby': 'q-hint q-error',
      });
      if (!inp.noColour) {
        box.append(el('div', { class: 'field' }, el('label', { for: inp.id, text: inp.label }), input));
        continue;
      }
      // flagColours row: the colour box and, at the end of the row, a "No colour" checkbox. Ticking it clears and disables the box.
      const none = el('input', { type: 'checkbox', id: inp.noColour.id, 'aria-label': inp.noColour.ariaLabel });
      none.addEventListener('change', () => {
        input.disabled = none.checked;
        if (none.checked) input.value = '';
      });
      box.append(el('div', { class: 'field colour-row' },
        el('label', { for: inp.id, text: inp.label }),
        el('div', { class: 'field-row' },
          el('span', { class: 'grow' }, input),
          el('label', { class: 'none-box', for: inp.noColour.id }, none, inp.noColour.label))));
    }
  }
}

// Shows an error under the answer boxes. The element is role="alert", so setting its text is what
// announces it (once). The same text twice in a row is cleared first so it is announced again.
function showQError(msg) {
  const e = $('q-error');
  if (e.textContent === msg) {
    e.textContent = '';
    setTimeout(() => { e.textContent = msg; }, 60);
  } else {
    e.textContent = msg;
  }
}

function invalidMessage(cat) {
  switch (cat.type) {
    case 'number-pct':
    case 'number-abs':
      return 'That is not a number I can read, so your turn is not used. Please try again.';
    case 'colours':
      return 'I did not recognise one of those colours, so your turn is not used. Use plain colour names such as red or dark blue, and tick "No colour" for a row you do not need.';
    default:
      return 'I could not read that answer, so your turn is not used. Please try again.';
  }
}

function onAnswerSubmit(e) {
  e.preventDefault();
  if (!game || stage() !== 'question') return;
  const cat = catById[turn.categoryId];
  const iso3 = turn.iso3;
  if (gameMode(game) === MODE_DISPLAY) {
    // "Show answer": reveal it unscored; the players mark Correct or Wrong next (SCHEMA 4.24)
    reveal = { correct: null, expectedText: formatExpected(cat, countries[iso3][cat.id], { countries, iso3 }), given: [], overruled: false };
    saveGame();
    renderGame();
    renderPlayers();
    return;
  }
  const inputEls = [...$('q-inputs').querySelectorAll('input[type="text"]')];
  const noneEls = [...$('q-inputs').querySelectorAll('input[type="checkbox"]')];
  let values = inputEls.map((i) => i.value);
  let input = values.length === 1 ? values[0] : values;
  if (cat.type === 'colours') {
    // flagColours (1.8): every row is a colour or ticked "No colour"; a ticked row is null. A row that is neither, or all
    // rows ticked, asks again and does not use the turn.
    const ticked = noneEls.map((c) => c.checked);
    const blank = inputEls.findIndex((i, n) => !ticked[n] && !/\p{L}/u.test(i.value));
    if (blank !== -1) {
      showQError('Please fill in every row or tick "No colour", so your turn is not used.');
      inputEls[blank].focus();
      return;
    }
    if (ticked.every(Boolean)) {
      showQError('At least one row needs a colour, so your turn is not used.');
      noneEls[0].focus();
      return;
    }
    input = inputEls.map((i, n) => (ticked[n] ? null : i.value));
    values = inputEls.map((i, n) => (ticked[n] ? `no colour (row ${n + 1})` : i.value));
  } else if (values.length > 1 && firstBlank(values) !== -1) {
    // Several boxes: every box must be filled in. A blank box asks again and does not use the turn.
    showQError('Please fill in every box, so your turn is not used.');
    inputEls[firstBlank(values)].focus();
    return;
  }
  let res;
  try {
    res = checkAnswer(cat, countries[iso3][cat.id], input, { countries, iso3 });
  } catch (err) {
    console.error('checkAnswer failed', err);
    showQError('Something went wrong checking that answer. Please try again.');
    return;
  }
  if (res.status === 'invalid') {
    showQError(invalidMessage(cat));
    // focus the row that caused it: a flagColours row with an unrecognised word, otherwise the first empty box
    const badRow = cat.type === 'colours' ? inputEls.find((i) => !i.disabled && parseColours(i.value) === null) : null;
    const firstEmpty = badRow || inputEls.find((i) => !i.disabled && i.value.trim() === '') || inputEls.find((i) => !i.disabled) || inputEls[0];
    firstEmpty.focus();
    return;
  }
  const correct = res.status === 'correct';
  game = applyResult(game, game.currentPlayer, cat.id, iso3, correct);
  reveal = {
    correct,
    expectedText: formatExpected(cat, countries[iso3][cat.id], { countries, iso3 }),
    given: values.map((v) => v.trim()).filter(Boolean),
    overruled: false,
  };
  saveGame();
  renderGame();
  renderPlayers();
}

function renderReveal(focus) {
  const cat = catById[turn.categoryId];
  const c = countries[turn.iso3];
  const p = game.players[game.currentPlayer];
  const label = questionLabel(cat, c[cat.id]);
  const panel = $('panel-reveal');
  const display = gameMode(game) === MODE_DISPLAY;
  const pending = reveal.correct === null; // display mode, not marked yet
  panel.classList.toggle('correct', reveal.correct === true);
  panel.classList.toggle('wrong', reveal.correct === false);
  if (display) {
    // Correct / Wrong are the players' own marks (SCHEMA 4.24): no automatic verdict, no "You answered", no overrule buttons
    $('reveal-title').textContent = pending ? 'The answer' : (reveal.correct ? 'Marked correct' : 'Marked wrong');
    $('display-marks').hidden = false;
    $('btn-mark-correct').setAttribute('aria-pressed', String(reveal.correct === true));
    $('btn-mark-wrong').setAttribute('aria-pressed', String(reveal.correct === false));
    $('btn-override-correct').hidden = true;
    $('btn-override-wrong').hidden = true;
  } else {
    $('reveal-title').textContent = reveal.overruled
      ? `${reveal.correct ? 'Correct' : 'Wrong'} (overruled)`
      : (reveal.correct ? 'Correct!' : 'Not quite.');
    $('display-marks').hidden = true;
    // the players can overrule the automatic check once per reveal; pressing the other button flips it back
    $('btn-override-correct').hidden = reveal.correct;
    $('btn-override-wrong').hidden = !reveal.correct;
  }
  $('btn-continue').disabled = !canContinue(reveal);
  const rStatus = $('reveal-status'); // CR-12: the country and its status note, when it has one
  rStatus.textContent = statusNote(c) ? `${c.name}: ${statusNote(c)}` : '';
  rStatus.hidden = !rStatus.textContent;
  $('reveal-given').textContent = !display && reveal.given.length ? `You answered: ${reveal.given.join(', ')}` : '';
  const exp = $('reveal-expected');
  const pics = imageItems(cat, c[cat.id]);
  const also = alsoAccepted(cat, c);
  const alsoEl = $('reveal-also');
  alsoEl.hidden = also.length === 0;
  alsoEl.textContent = also.length ? `Also accepted: ${also.join(', ')}` : '';
  if (pics) {
    // famous people, dishes, landmarks and the drink (alcohol: one item): every stored name with its picture, no 5-example cap
    exp.replaceChildren(cat.id === 'landmarks' ? 'Answer: any famous landmark is correct. The main ones:'
      : (pics.length > 1 ? 'Answer: any one of these is correct.' : 'Answer:'));
    renderImageList(pics, cat.id === 'dish' ? 'dish' : cat.id === 'landmarks' ? 'landmark' : cat.id === 'alcohol' ? 'drink' : 'person');
  } else {
    exp.replaceChildren('Answer: ', el('span', { class: 'expected', text: reveal.expectedText }));
    $('reveal-images').hidden = true;
    $('reveal-images').replaceChildren();
  }
  renderRankAround(cat);
  $('reveal-outcome').textContent = pending
    ? 'Choose Correct or Wrong to carry on.'
    : reveal.correct
      ? `${c.name} is now in ${p.name}'s collection. ${label} is used up for ${p.name}.`
      : `${c.name} stays in the pool. ${label} is used up for ${p.name}.`;
  updateContinueLabel();
  if (focus) focusSoon($('reveal-title'));
}

// ---- reveal extras ----

const PLACEHOLDER_SVG = {
  // neutral silhouettes, inline so no file is needed (drawn in the .thumb colours)
  person: '<svg viewBox="0 0 56 56" aria-hidden="true" focusable="false"><circle cx="28" cy="21" r="9" stroke="none"/><path d="M10 52c0-11 8-18 18-18s18 7 18 18z" stroke="none"/></svg>',
  dish: '<svg viewBox="0 0 56 56" aria-hidden="true" focusable="false" style="fill:none" stroke-width="3"><circle cx="28" cy="28" r="19"/><circle cx="28" cy="28" r="11"/></svg>',
  drink: '<svg viewBox="0 0 56 56" aria-hidden="true" focusable="false"><path d="M24 4h8v13l5 6v26a3 3 0 0 1-3 3H22a3 3 0 0 1-3-3V23l5-6z" stroke="none"/><rect x="22" y="31" width="12" height="11" rx="1" fill="#0d1017" stroke="none"/></svg>',
  landmark: '<svg viewBox="0 0 56 56" aria-hidden="true" focusable="false"><path d="M6 20 28 8l22 12z" stroke="none"/><rect x="10" y="24" width="6" height="18" stroke="none"/><rect x="25" y="24" width="6" height="18" stroke="none"/><rect x="40" y="24" width="6" height="18" stroke="none"/><rect x="6" y="45" width="44" height="5" stroke="none"/></svg>',
};

function imageRow(item, kind) {
  const holder = el('span', { class: 'thumb', 'aria-hidden': 'true' });
  const placeholder = () => { holder.innerHTML = PLACEHOLDER_SVG[kind]; };
  if (item.image) {
    // alt is empty: the visible name next to it is the text alternative
    const img = el('img', { src: item.image, alt: '', width: '56', height: '56', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', placeholder, { once: true });
    holder.append(img);
  } else {
    placeholder();
  }
  return el('li', { class: 'image-item' }, holder, el('span', { class: 'image-name', text: item.name }));
}

function renderImageList(items, kind) {
  const list = $('reveal-images');
  list.className = 'image-list' + (kind === 'dish' ? ' dishes' : kind === 'landmark' ? ' landmarks' : kind === 'drink' ? ' drinks' : '');
  list.replaceChildren(...items.map((it) => imageRow(it, kind)));
  list.hidden = false;
}

// A wrong military rank: show the countries ranked around the number the player typed.
function renderRankAround(cat) {
  const box = $('reveal-around');
  box.replaceChildren();
  box.hidden = true;
  if (cat.id !== 'militaryRank' || reveal.correct || gameMode(game) === MODE_DISPLAY) return;
  const rank = parseNumber(reveal.given[0], 'militaryRank');
  if (rank === null) return;
  const around = militaryNeighbours(countries, rank);
  if (!around.length) return;
  box.append(
    el('p', { class: 'muted', text: `You said ${rank}:` }),
    el('ul', {}, around.map((a) => el('li', { class: a.rank === rank ? 'at' : '' },
      `${a.rank} · `, a.name,
      a.rank === rank ? el('span', { class: 'you', text: ' (your answer)' }) : ''))));
  box.hidden = false;
}

// "Next player: X" or "See results"; recomputed when a vote changes during the reveal.
function updateContinueLabel() {
  if (reveal.correct === null) { $('btn-continue').textContent = 'Continue'; return; } // display mode, not marked yet
  const over = isGameOver(game);
  const after = over ? null : nextPlayer(game);
  const finished = over || isGameOver(after);
  $('btn-continue').textContent = finished ? 'See results' : `Next player: ${after.players[after.currentPlayer].name}`;
}

// Flip the result of the answer just given (SCHEMA 4.23). The state function does the move; the reveal keeps
// whether the players' choice differs from the automatic check, and is saved with the game.
function onOverride(wantCorrect) {
  if (!game || !reveal || stage() !== 'reveal' || reveal.correct === wantCorrect) return;
  const original = reveal.overruled ? !reveal.correct : reveal.correct;
  game = overrideResult(game, game.currentPlayer, turn.iso3, wantCorrect);
  reveal = { ...reveal, correct: wantCorrect, overruled: wantCorrect !== original };
  saveGame();
  renderGame({ focus: false });
  renderPlayers();
  announce(`${$('reveal-title').textContent}. ${$('reveal-outcome').textContent}`);
  focusSoon($('reveal-title')); // the heading now names the new result; Tab goes on to Continue, then to the other override button
}

// Display mode (SCHEMA 4.24): the players mark the answer Correct or Wrong. The first mark scores the answer like
// applyResult; a later mark before Continue changes it like overrideResult.
function onMark(wantCorrect) {
  if (!game || !reveal || stage() !== 'reveal' || gameMode(game) !== MODE_DISPLAY || reveal.correct === wantCorrect) return;
  game = applyDisplayResult(game, game.currentPlayer, turn.categoryId, turn.iso3, wantCorrect, reveal.correct !== null);
  reveal = { ...reveal, correct: wantCorrect };
  saveGame();
  renderGame({ focus: false }); // the buttons are not rebuilt, so focus stays on the one just pressed
  renderPlayers();
  announce(`${$('reveal-title').textContent}. ${$('reveal-outcome').textContent}`);
}

function onContinue() {
  if (!game || !reveal || !canContinue(reveal)) return;
  if (!isGameOver(game)) game = nextPlayer(game);
  turn = null;
  reveal = null;
  builtQuestionKey = null;
  if (isGameOver(game)) {
    finishGame();
  } else {
    saveGame();
    renderGame();
    renderPlayers();
    announce(`${game.players[game.currentPlayer].name}'s turn`);
  }
}

// ---- players panel ----

function renderPlayers() {
  const active = document.activeElement;
  const activeId = active && active.id && $('players-list').contains(active) ? active.id : null;
  const list = $('players-list');
  list.replaceChildren();
  game.players.forEach((p, i) => {
    const isCurrent = i === game.currentPlayer && !isGameOver(game);
    const left = availableCategories(game, i).length;
    const voteId = `vote-${i}`;
    // Once the game has ended (final reveal) a vote can change nothing, so the box is switched off.
    const vote = el('input', { type: 'checkbox', id: voteId, disabled: isGameOver(game) });
    vote.checked = p.voteEnd;
    vote.addEventListener('change', () => {
      if (isGameOver(game)) return;
      game = setVote(game, i, vote.checked);
      saveGame();
      renderPlayers();
      if (reveal) updateContinueLabel();
      announce(`${p.name} ${vote.checked ? 'voted to end the game' : 'withdrew the vote to end'}`);
    });
    const sorted = p.set.slice().sort((a, b) => countries[a].name.localeCompare(countries[b].name));
    const details = el('details', {},
      el('summary', { text: `Countries won (${sorted.length})` }),
      sorted.length
        ? el('ul', { class: 'won-list' }, sorted.map((iso3) => countryItem(iso3)))
        : el('p', { class: 'none small', text: 'None yet.' }));
    if (openDetails.has(i)) details.open = true;
    details.addEventListener('toggle', () => { if (details.open) openDetails.add(i); else openDetails.delete(i); });
    list.append(el('li', { class: 'player' + (isCurrent ? ' current' : ''), ...(isCurrent ? { 'aria-current': 'true' } : {}) },
      el('div', { class: 'p-head' },
        swatch(p.colour),
        el('span', { class: 'p-name', text: p.name }),
        isCurrent ? el('span', { class: 'badge', text: 'Turn' }) : null),
      el('div', { class: 'p-stats', text: `${plural(p.set.length, 'country', 'countries')} · ${plural(left, 'category', 'categories')} left${left === 0 ? ' (finished)' : ''}` }),
      el('label', { class: 'vote', for: voteId }, vote, `Vote to end`, el('span', { class: 'sr-only', text: ` (${p.name})` })),
      details));
  });
  if (activeId) {
    const again = $(activeId);
    if (again) again.focus();
  }
}

// ---------------------------------------------------------------------------
// Results screen
// ---------------------------------------------------------------------------

const END_TEXT = {
  'pool-empty': 'Every country has been won.',
  'no-categories': 'Every player has used up all their categories.',
  'all-voted': 'All players voted to end the game.',
};

function finishGame() {
  clearSave();
  gameToken++;
  renderResults();
  showScreen('results');
  focusSoon($('results-title'));
}

function renderResults() {
  const rows = ranking(game);
  $('results-reason').textContent = END_TEXT[endReason(game)] || 'The game is over.';
  const top = rows.filter((r) => r.rank === 1);
  let winner;
  if (top[0].count === 0) winner = 'Nobody won a country.';
  else if (top.length === 1) winner = `${top[0].name} wins with ${plural(top[0].count, 'country', 'countries')}!`;
  else winner = `It is a tie between ${listAnd(top.map((r) => r.name))} with ${plural(top[0].count, 'country', 'countries')} each.`;
  $('results-winner').textContent = winner;
  const list = $('results-list');
  list.replaceChildren();
  for (const row of rows) {
    const tied = rows.filter((r) => r.rank === row.rank).length > 1;
    const sorted = row.countries.slice().sort((a, b) => countries[a].name.localeCompare(countries[b].name));
    list.append(el('li', { class: 'rank-item' },
      el('div', { class: 'rank-head' },
        el('span', { class: 'rank-num' }, el('span', { class: 'sr-only', text: 'Rank ' }), String(row.rank)),
        swatch(row.colour),
        el('span', { class: 'rank-name', text: row.name }),
        el('span', { class: 'rank-score', text: plural(row.count, 'country', 'countries') }),
        tied ? el('span', { class: 'rank-tie', text: '(tied)' }) : null),
      sorted.length
        ? el('ul', { class: 'won-list', 'aria-label': `Countries won by ${row.name}` }, sorted.map((iso3) => countryItem(iso3)))
        : el('p', { class: 'none', text: 'No countries won.' })));
  }
  renderEmpires();
}

// ---- empire map (SCHEMA 4.25) ----

function loadWorldMap() {
  if (!worldmapPromise) worldmapPromise = fetchJson('data/worldmap.json').catch((e) => { worldmapPromise = null; throw e; });
  return worldmapPromise;
}

// Started a moment after a game starts, so the results screen usually finds the file already loaded. Failure is silent here.
function prefetchWorldMap() {
  setTimeout(() => { loadWorldMap().catch(() => {}); }, 1500);
}

function setMapFilter(selected) {
  mapFilter = selected;
  const buttons = $('empires-filter').querySelectorAll('button');
  buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === String(selected))));
  if (empireMap) empireMap.setFilter(selected);
}

// ---- full screen (SCHEMA 4.25): the Empires block goes full screen with the Fullscreen API, or a fixed overlay when the
// browser has none for ordinary elements (iPhone Safari). Focus goes to "Exit full screen" and back to "Full screen". ----

function onZoomChange(z) {
  $('zoom-in').setAttribute('aria-disabled', String(z >= MAX_ZOOM - 1e-6));
  $('zoom-out').setAttribute('aria-disabled', String(z <= MIN_ZOOM + 1e-6));
  $('zoom-reset').setAttribute('aria-disabled', String(z <= MIN_ZOOM + 1e-6));
}

function enterFsUi(mode) {
  if (fsMode) return;
  fsMode = mode;
  const root = $('empires');
  root.classList.add('fs', mode === 'overlay' ? 'fs-overlay' : 'fs-native');
  if (mode === 'overlay') {
    document.documentElement.classList.add('fs-lock');
    document.addEventListener('keydown', onOverlayKey);
  }
  $('fs-enter').hidden = true;
  $('fs-exit').hidden = false;
  if (empireMap) empireMap.setFullscreen(true);
  onZoomChange(1);
  $('fs-exit').focus();
}

function exitFsUi() {
  if (!fsMode) return;
  const root = $('empires');
  root.classList.remove('fs', 'fs-overlay', 'fs-native');
  document.documentElement.classList.remove('fs-lock');
  document.removeEventListener('keydown', onOverlayKey);
  fsMode = null;
  $('fs-enter').hidden = false;
  $('fs-exit').hidden = true;
  if (empireMap) empireMap.setFullscreen(false);
  $('fs-enter').focus();
}

function onOverlayKey(ev) {
  if (ev.key === 'Escape' && fsMode === 'overlay') { ev.preventDefault(); exitFsUi(); }
}

function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function enterFullscreen() {
  const root = $('empires');
  if (fsMode) return;
  const request = root.requestFullscreen || root.webkitRequestFullscreen;
  if (typeof request !== 'function' || document.fullscreenEnabled === false) { enterFsUi('overlay'); return; }
  try {
    const p = request.call(root);
    if (p && typeof p.then === 'function') p.catch(() => { if (!fsMode) enterFsUi('overlay'); });
  } catch {
    enterFsUi('overlay');
  }
}

function exitFullscreen() {
  if (fsMode === 'overlay') { exitFsUi(); return; }
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (fsElement() && typeof exit === 'function') exit.call(document);
  else exitFsUi();
}

// the browser's own exit (Escape, a gesture) and our request both end up here
function onFullscreenChange() {
  if (fsElement() === $('empires')) enterFsUi('native');
  else if (fsMode === 'native') exitFsUi();
}

async function renderEmpires() {
  const token = ++empiresToken;
  if (fsMode) { if (fsMode === 'overlay') exitFsUi(); else exitFullscreen(); }
  $('fs-enter').disabled = true;
  if (empireMap) { empireMap.destroy(); empireMap = null; }
  mapFilter = FILTER_ALL;
  const bar = $('empires-filter');
  bar.replaceChildren();
  const mk = (value, kids) => {
    const b = el('button', { type: 'button', class: 'btn secondary filter-btn', 'data-filter': String(value), 'aria-pressed': String(value === FILTER_ALL) }, kids);
    b.addEventListener('click', () => setMapFilter(value));
    return b;
  };
  bar.append(mk(FILTER_ALL, ['All']));
  game.players.forEach((p, i) => bar.append(mk(i, [swatch(p.colour), el('span', { class: 'filter-name', text: p.name }), el('span', { class: 'filter-count', text: ` (${p.set.length})` })])));
  const box = $('empires-map');
  box.className = 'empires-map';
  box.replaceChildren(el('p', { class: 'muted', text: 'Loading map...' }));
  try {
    const wm = await loadWorldMap();
    if (token !== empiresToken) return;
    empireMap = createEmpireMap(box, { worldmap: wm, players: game.players, nameOf: (iso3) => countries[iso3].name, statusOf: (iso3) => statusNote(countries[iso3]), onZoom: onZoomChange });
    empireMap.setFilter(mapFilter);
    $('fs-enter').disabled = false;
  } catch (err) {
    if (token !== empiresToken) return;
    console.error('Could not load the map', err);
    const retry = el('button', { type: 'button', class: 'btn secondary', text: 'Try again' });
    retry.addEventListener('click', () => renderEmpires());
    box.replaceChildren(el('p', { class: 'error', text: 'The map could not be loaded. The lists below still show every country.' }), retry);
  }
}

// ---------------------------------------------------------------------------
// Confirm dialog and new game
// ---------------------------------------------------------------------------

function confirmDialog(title, text, okLabel, cancelLabel = 'Keep playing') {
  const dlg = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = okLabel;
  $('confirm-cancel').textContent = cancelLabel;
  if (typeof dlg.showModal !== 'function') return Promise.resolve(window.confirm(`${title}\n${text}`));
  return new Promise((resolve) => {
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'confirm'), { once: true });
    dlg.showModal();
  });
}

async function onNewGame() {
  if (game && !isGameOver(game)) {
    const ok = await confirmDialog('Start a new game?', 'The game in progress will be lost.', 'Yes, new game');
    if (!ok) return;
  }
  clearSave();
  goToSetup();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  try {
    [countries, categories] = await Promise.all([fetchJson('data/countries.json'), fetchJson('data/categories.json')]);
  } catch (err) {
    $('load-message').hidden = true;
    const box = $('load-error');
    box.hidden = false;
    box.textContent = 'Could not load the game data. This game has to be served over HTTP: run "python -m http.server" in the game folder and open http://localhost:8000/ (opening index.html directly from disk does not work).';
    return;
  }
  catById = Object.fromEntries(categories.map((c) => [c.id, c]));
  $('load-message').hidden = true;

  catWheel = createWheel($('canvas-cat'));

  $('btn-add-player').addEventListener('click', () => {
    if (setupNames.length >= MAX_PLAYERS) return;
    setupNames.push('');
    setupColours.push(randomUnusedColour(setupColours));
    renderSetup(setupNames.length - 1);
  });
  $('setup-form').addEventListener('submit', onSetupSubmit);
  $('btn-resume').addEventListener('click', resumeSaved);
  $('btn-discard').addEventListener('click', () => {
    clearSave();
    renderResumeBox();
    announce('Saved game discarded.');
    focusSoon($('player-name-0'));
  });
  $('btn-spin').addEventListener('click', onSpin);
  $('answer-form').addEventListener('submit', onAnswerSubmit);
  $('btn-continue').addEventListener('click', onContinue);
  $('btn-override-correct').addEventListener('click', () => onOverride(true));
  $('btn-override-wrong').addEventListener('click', () => onOverride(false));
  $('btn-mark-correct').addEventListener('click', () => onMark(true));
  $('btn-mark-wrong').addEventListener('click', () => onMark(false));
  $('fs-enter').addEventListener('click', enterFullscreen);
  $('fs-exit').addEventListener('click', exitFullscreen);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  const zoomBtn = (id, fn) => $(id).addEventListener('click', () => { if (empireMap) { fn(); announce(`Zoom ${Math.round(empireMap.getZoom() * 100)} percent`); } });
  zoomBtn('zoom-in', () => empireMap.zoomBy(ZOOM_STEP));
  zoomBtn('zoom-out', () => empireMap.zoomBy(1 / ZOOM_STEP));
  zoomBtn('zoom-reset', () => empireMap.resetZoom());
  $('btn-new-game').addEventListener('click', onNewGame);
  $('btn-results-new').addEventListener('click', onNewGame);
  $('btn-play-again').addEventListener('click', () => startGame(game.players.map((p) => p.name), gameMode(game), game.players.map((p) => p.colour)));

  goToSetup();
  focusSoon(null);
}

init();
