// Geo Game UI: screen flow and event wiring. All game rules live in state.js / answer.js; this file
// only renders state and forwards events.
//
// Turn stages (derived, never stored): category -> country -> question -> reveal.
//   turn   = null | { categoryId, iso3? }   category (and country) already spun this turn
//   reveal = null | { correct, expectedText, given, overruled? }   answer already checked and applied to the state;
//                      correct is the result in force, overruled is true when the players flipped the automatic check
//                      Display mode (SCHEMA 4.24): correct is null until the players mark Correct or Wrong (nothing is
//                      scored before that); given is always empty and overruled is false.
//                      timedOut (SCHEMA 4.27, optional) is true when the answer timer ran out and ended the question.
//
// Developer hooks (harmless in play, used by the headless playtest):
//   ?fast                       short wheel animation and no pause after landing
//   (the answer timer reads Date.now(); the QA scripts fake it by overriding Date.now in the test browser only)
//   globalThis.__geoForce       { category: 'outline' (or 'flag'), country: 'MLT' } makes the next spin land there

import {
  createGame, availableCategories, eligibleCountries, applyResult, overrideResult, setVote, nextPlayer,
  isGameOver, endReason, ranking, gameMode, validMode, applyDisplayResult, canContinue, MODE_TYPE, MODE_DISPLAY,
  PALETTE, colourOf, colourHex, randomColours, randomUnusedColour, changeColour, isColourTaken, fillColours,
  REGIONS, defaultCategoryIds, categoriesByLabel, CATEGORY_PACKS, CUSTOM_PACK_ID, packById, matchingPackId, regionCounts, planGame, parseFilters, filtersOf, filterSummary, inScope, gameTimer, validTimer,
  gameSkipSpin, validSkipSpin,
} from './state.js';
import { createTimer, milestoneMessage, timeUpAnswer } from './timer.js';
import { createEmpireMap, framingView, FILTER_ALL, MAX_ZOOM, MIN_ZOOM, ZOOM_STEP } from './worldmap.js';
import { createWheel } from './wheel.js';
import { checkAnswer, parseNumber, parseColours } from './answer.js';
import { REPORT } from './report-config.js';
import { isConfigured, buildPayload, sendReport } from './report.js';
import {
  buildQuestion, questionLabel, formatExpected, listAnd, firstBlank, imageItems, alsoAccepted, militaryNeighbours, displayHint, displayPrompt, statusNote,
  droppedNotice, formatRange, hidesCountry, wheelItems,
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
let setupTimer = true;     // the answer timer box on the setup screen (SCHEMA 4.27); remembered between games
let setupSkipSpin = false; // the "Skip the spin" box on the setup screen (SCHEMA 4.29); remembered between games
let reportUi = { key: null, state: 'idle', message: '', error: false }; // "Report wrong answer" on the reveal (SCHEMA 4.28), one per reveal
let timerKey = null;       // the question the answer timer belongs to (null = no timer is tied to a question)
// The optional filters ticked on the setup screen (SCHEMA 4.26): a checkbox each, and the ticked items of its panel. Remembered
// between games (New game pre-fills the last used settings); filled with every item when countries and categories are loaded.
let setupFilters = { catsOn: false, cats: new Set(), regsOn: false, regs: new Set() };
let catWheel = null;
let countryWheel = null;
let countryWheelHidden = null;
let shownOutlineUrl = null;
let shownFlagUrl = null;   // CR-22: the flag file shown in the question panel
let builtQuestionKey = null;
const outlineCache = new Map();
const flagCache = new Map();   // flag file path -> Promise of a blob: URL (the file path, which holds the iso3, never reaches the DOM)
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
    && (rv.overruled === undefined || typeof rv.overruled === 'boolean')
    && (rv.timedOut === undefined || typeof rv.timedOut === 'boolean');
}

// Returns { game, turn, reveal } for a usable save, otherwise null. Never throws.
function parseSave(raw) {
  try {
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object' || d.v !== 1 || !d.game || typeof d.game !== 'object') return null;
    const g = { ...d.game, countries };
    if (!validMode(g.mode)) return null;
    g.mode = gameMode(g); // a save from before CR-10 has no mode and loads as 'type'
    if (!validTimer(g.timer)) return null;
    g.timer = gameTimer(g); // a save from before CR-16 has no timer setting and loads with the timer on (SCHEMA 4.27)
    if (!validSkipSpin(g.skipSpin)) return null;
    g.skipSpin = gameSkipSpin(g); // a save from before CR-20 has none and spins normally (SCHEMA 4.29)
    if (!Array.isArray(g.players)) return null;
    // Filters (SCHEMA 4.26): a save from before CR-15 has none and plays the whole world with every category.
    const filters = parseFilters(g.filters, countries, Object.keys(catById));
    if (!filters) return null;
    g.filters = { ...filters, dropped: filters.dropped.slice() };
    const n = g.players.length;
    if (n < MIN_PLAYERS || n > MAX_PLAYERS) return null;
    if (g.phase !== 'playing' && g.phase !== 'ended') return null;
    if (!Number.isInteger(g.currentPlayer) || g.currentPlayer < 0 || g.currentPlayer >= n) return null;
    if (!Number.isInteger(g.round) || g.round < 1) return null;
    // Own-key lookups only: a saved id such as "constructor" must not match an inherited property.
    const isCountry = (c) => isStr(c) && Object.hasOwn(countries, c);
    const inRegions = (c) => g.filters.regions === null || g.filters.regions.includes(countries[c].region);
    const isCategory = (c) => isStr(c) && Object.hasOwn(catById, c);
    if (!Array.isArray(g.pool) || !g.pool.every(isCountry) || !g.pool.every(inRegions)) return null;
    const owned = new Set(g.pool);
    if (owned.size !== g.pool.length) return null;
    for (const p of g.players) {
      if (!p || typeof p !== 'object' || !isStr(p.name) || p.name === '') return null;
      if (typeof p.voteEnd !== 'boolean') return null;
      if (!Array.isArray(p.set) || !Array.isArray(p.remainingCategories)) return null;
      if (!p.set.every(isCountry) || !p.set.every(inRegions)) return null;
      // Each country is in exactly one place: the pool or one player's set.
      for (const c of p.set) {
        if (owned.has(c)) return null;
        owned.add(c);
      }
      if (!p.remainingCategories.every(isCategory)) return null;
      if (g.filters.categories !== null && !p.remainingCategories.every((id) => g.filters.categories.includes(id))) return null;
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
  if (name !== 'game') { $('mode-label').hidden = true; $('filter-label').hidden = true; }
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
  $('opt-timer').checked = setupTimer;
  $('opt-skip').checked = setupSkipSpin;
  renderFilters();
  if (focusIndex !== null) focusSoon($(`player-name-${focusIndex}`));
  if (focusId) focusSoon($(focusId));
  if (focusRadio) {
    const r = document.querySelector(`#colour-picker-${focusRadio.row} input[value="${focusRadio.value}"]`);
    if (r) focusSoon(r);
  }
}

// ---- optional filters (SCHEMA 4.26) ----

function allCategoryIds() { return categories.map((c) => c.id); }

// Fills the remembered setup filters once the data is loaded: every region ticked, and every category ticked except the ones a
// default game leaves out (DEFAULT_OFF in state.js, CR-23).
function initSetupFilters() {
  setupFilters = { catsOn: false, cats: new Set(defaultCategoryIds(allCategoryIds())), regsOn: false, regs: new Set(REGIONS) };
}

// Sets the setup filters to what a game used (Play again, resume), so New game pre-fills them.
function setSetupFromFilters(f) {
  setupFilters = {
    catsOn: f.categories !== null, cats: new Set(f.categories === null ? defaultCategoryIds(allCategoryIds()) : f.categories),
    regsOn: f.regions !== null, regs: new Set(f.regions === null ? REGIONS : f.regions),
  };
}

// What the setup screen asks for: null where a filter is off.
function chosenFilters() {
  return {
    categories: setupFilters.catsOn ? allCategoryIds().filter((id) => setupFilters.cats.has(id)) : null,
    regions: setupFilters.regsOn ? REGIONS.filter((r) => setupFilters.regs.has(r)) : null,
  };
}

function filterCountText(n, total, noun) {
  return `${n} of ${total} ${noun} selected`;
}

function updateFilterCounts() {
  $('cats-count').textContent = filterCountText(setupFilters.cats.size, categories.length, 'categories');
  $('regions-count').textContent = filterCountText(setupFilters.regs.size, REGIONS.length, 'regions');
  updatePackButtons();
}

// ---- category packs (CR-25): shortcut buttons above the checklist; the pack whose set equals the ticks is shown pressed ----

// Whether the A to Z checklist under "Categories" is open. Not saved: it is closed again whenever the page loads or setup is re-entered.
let catsListOpen = false;
// The last selection made in this setup visit that matched no pack; the Custom button brings it back (CR-25 amendment 1). Not saved.
let lastCustom = null;

function updatePackButtons() {
  const current = matchingPackId(allCategoryIds(), setupFilters.cats);
  if (current === CUSTOM_PACK_ID) lastCustom = [...setupFilters.cats]; // remembered for the Custom button
  for (const btn of $('cats-packs').querySelectorAll('button')) btn.setAttribute('aria-pressed', String(btn.dataset.pack === current));
}

function setCatsListOpen(open) {
  catsListOpen = open;
  $('cats-toggle').setAttribute('aria-expanded', String(open));
  $('cats-list').hidden = !open;
}

// All, Default (and any later pack), then Custom, then None: Custom goes just before the pack called 'none'.
function renderPacks() {
  const button = (id, label) => el('button', { type: 'button', class: 'btn secondary pack', id: `pack-${id}`, 'data-pack': id, 'aria-pressed': 'false', text: label });
  const buttons = CATEGORY_PACKS.map((p) => button(p.id, p.label));
  const at = CATEGORY_PACKS.findIndex((p) => p.id === 'none');
  buttons.splice(at < 0 ? buttons.length : at, 0, button(CUSTOM_PACK_ID, 'Custom'));
  $('cats-packs').replaceChildren(...buttons);
}

// Custom: bring back the last custom selection (if there is one) and open the checklist so boxes can be ticked.
function onCustomPress() {
  if (lastCustom) {
    const keep = new Set(lastCustom);
    setupFilters.cats.clear();
    keep.forEach((v) => setupFilters.cats.add(v));
    $('filter-error').textContent = '';
    for (const box of $('cats-list').querySelectorAll('input')) box.checked = keep.has(box.value);
    updateFilterCounts();
  }
  setCatsListOpen(true);
}

function onPackPress(id) {
  const pack = packById(id);
  if (!pack) return;
  const ids = new Set(pack.ids(allCategoryIds()));
  setupFilters.cats.clear();
  ids.forEach((v) => setupFilters.cats.add(v));
  $('filter-error').textContent = '';
  for (const box of $('cats-list').querySelectorAll('input')) box.checked = ids.has(box.value);
  updateFilterCounts();
}

// One filter block: the checkbox that opens the panel, and the checkbox list inside it.
function renderFilterBlock({ toggle, panel, list, on, items, chosen, idPrefix }) {
  $(toggle).checked = on;
  $(toggle).setAttribute('aria-expanded', String(on));
  $(panel).hidden = !on;
  $(list).replaceChildren(...items.map(({ value, label }) => {
    const id = `${idPrefix}-${value}`;
    const box = el('input', { type: 'checkbox', id, value });
    box.checked = chosen.has(value);
    box.addEventListener('change', () => {
      if (box.checked) chosen.add(value); else chosen.delete(value);
      $('filter-error').textContent = '';
      updateFilterCounts();
    });
    return el('label', { class: 'check', for: id }, box, el('span', { text: label }));
  }));
}

function renderFilters() {
  const counts = regionCounts(countries);
  renderFilterBlock({
    toggle: 'opt-cats', panel: 'cats-panel', list: 'cats-list', on: setupFilters.catsOn, chosen: setupFilters.cats, idPrefix: 'cat',
    items: categoriesByLabel(categories).map((c) => ({ value: c.id, label: c.label })), // A to Z; stored lists keep data order (CR-24)
  });
  renderFilterBlock({
    toggle: 'opt-regions', panel: 'regions-panel', list: 'regions-list', on: setupFilters.regsOn, chosen: setupFilters.regs, idPrefix: 'region',
    items: REGIONS.map((r) => ({ value: r, label: `${r} (${counts[r]})` })),
  });
  renderPacks();
  setCatsListOpen(catsListOpen);
  updateFilterCounts();
}

function onFilterToggle(key, toggleId, panelId) {
  const on = $(toggleId).checked;
  setupFilters[key] = on;
  $(toggleId).setAttribute('aria-expanded', String(on));
  $(panelId).hidden = !on;
  $('filter-error').textContent = '';
}

function onFilterAll(set, values, listId) {
  values.forEach((v) => set.add(v));
  $('filter-error').textContent = '';
  for (const box of $(listId).querySelectorAll('input')) box.checked = true;
  updateFilterCounts();
}

function onFilterNone(set, listId) {
  set.clear();
  $('filter-error').textContent = '';
  for (const box of $(listId).querySelectorAll('input')) box.checked = false;
  updateFilterCounts();
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
  stopTimer();
  clearTimerLive();
  game = null;
  turn = null;
  reveal = null;
  busy = false;
  builtQuestionKey = null;
  setupNames = lastNames ? lastNames.slice() : ['', ''];
  setupColours = lastColours && lastNames && lastColours.length === lastNames.length ? lastColours.slice() : randomColours(setupNames.length);
  openPicker = null;
  lastCustom = null;
  catsListOpen = false; // CR-25: the category checklist starts collapsed each time setup opens
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
  const filters = chosenFilters();
  const plan = planGame(countries, categories, filters);
  if (!plan.ok) {
    $('filter-error').textContent = plan.message;
    // the panel that needs a tick is open (the error comes from its checkbox being on); put focus on its first box
    // (the category checklist may be collapsed, so then the first pack button gets focus instead)
    const first = plan.error === 'categories' ? (catsListOpen ? $('cats-list') : null) : plan.error === 'regions' ? $('regions-list') : null;
    focusSoon(first ? first.querySelector('input') : plan.error === 'categories' || $('opt-cats').checked ? $('pack-all') : $('regions-all'));
    return;
  }
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
  startGame(names, mode, setupColours.slice(), filters, $('opt-timer').checked, $('opt-skip').checked);
}

function startGame(names, mode = MODE_TYPE, colours = undefined, filters = null, timer = true, skipSpin = false) {
  gameToken++;
  stopTimer();
  clearTimerLive();
  lastNames = names.slice();
  setupMode = mode;
  setupTimer = timer !== false;
  setupSkipSpin = skipSpin === true;
  game = createGame(names, countries, categories, mode, colours, filters, setupTimer, setupSkipSpin);
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
  const note = droppedNoteText();
  if (note) announce(note);
}

function resumeSaved() {
  const saved = loadSave();
  if (!saved) { renderResumeBox(); return; }
  try {
    gameToken++;
    stopTimer();
    clearTimerLive();
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
    setupTimer = gameTimer(game);
    setupSkipSpin = gameSkipSpin(game);
    setSetupFromFilters(filtersOf(game));
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
  return wheelItems(cat, eligibleCountries(game, cat.id), countries); // outline and flag (CR-22): blank labels, the country is not readable from the wheel
}

function getCountryWheel(hideNames) {
  if (!countryWheel || countryWheelHidden !== hideNames) {
    if (countryWheel) countryWheel.destroy();
    // outline and flag: no centre label (showResult false) and blank slice labels (see countryItems)
    countryWheel = createWheel($('canvas-country'), { showResult: !hideNames });
    countryWheelHidden = hideNames;
  }
  return countryWheel;
}

// "Highest point has no data for these countries and was left out." (empty when nothing was dropped)
function droppedNoteText() {
  return droppedNotice(filtersOf(game).dropped.map((id) => catById[id].label));
}

function renderGame({ focus = true } = {}) {
  const p = game.players[game.currentPlayer];
  const st = stage();
  const left = availableCategories(game, game.currentPlayer).length;
  const display = gameMode(game) === MODE_DISPLAY;
  $('mode-label').textContent = display ? 'Display mode' : 'Type mode';
  $('mode-label').hidden = false;
  const summary = filterSummary(game);
  $('filter-label').textContent = summary;
  $('filter-label').hidden = !summary;
  const dropped = droppedNoteText();
  $('turn-dropped').textContent = dropped;
  $('turn-dropped').hidden = !dropped;
  $('turn-title').replaceChildren(swatch(p.colour, ' lead'), `${p.name}'s turn`);
  $('turn-sub').textContent = `Round ${game.round} · ${plural(p.set.length, 'country', 'countries')} won · ${plural(left, 'category', 'categories')} left`;

  const spinning = st === 'category' || st === 'country';
  if (spinning) stopTimer(); // the timer never runs while no question is shown
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
    const hide = hidesCountry(cat);
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
    syncTimer(st);
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
  stopTimer();
  const token = gameToken;
  const st = stage();
  if (st !== 'category' && st !== 'country') return;
  busy = true;
  let failed = false;
  // Move focus to the status line before the button is disabled, so focus does not fall to the page.
  $('spin-status').textContent = 'Spinning...';
  $('spin-status').focus();
  $('btn-spin').disabled = true;
  const skip = gameSkipSpin(game); // SCHEMA 4.29: the wheels land at once, same random pick, no animation and no landing pause
  const opts = (items, kind) => ({ rng: rngFor(items, kind), durationMs: FAST ? 40 : undefined, instant: skip });
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
      const hide = hidesCountry(cat);
      const items = countryItems(cat);
      const item = await getCountryWheel(hide).spin(items, opts(items, 'country'));
      if (token !== gameToken) return;
      turn = { categoryId: cat.id, iso3: item.id };
      builtQuestionKey = null;
      if (hide) {
        $('spin-status').textContent = 'A country has been chosen.';
        announce(`A country has been chosen. Its ${cat.type === 'flag' ? 'flag' : 'outline'} is shown next.`);
      } else {
        $('spin-status').textContent = `Landed on: ${countries[item.id].name}`;
        announce(`Country: ${countries[item.id].name}`);
      }
    }
    saveGame();
    if (LANDING_PAUSE_MS && !skip) await wait(LANDING_PAUSE_MS);
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

// CR-22: the flag picture. The file is fetched and shown through a blob: URL so that its path (which holds the country's iso3) is not in
// the page; the alt text is the same for every flag and does not name the country. Loading and error states like the outline's.
function loadFlag(url) {
  if (!flagCache.has(url)) {
    flagCache.set(url, fetch(url)
      .then((r) => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.blob(); })
      .then((b) => URL.createObjectURL(new Blob([b], { type: 'image/svg+xml' })))
      .catch((e) => { flagCache.delete(url); throw e; }));
  }
  return flagCache.get(url);
}

async function showFlag(url) {
  const box = $('q-flag');
  box.hidden = false;
  if (shownFlagUrl === url && box.querySelector('img')) return;
  shownFlagUrl = url;
  box.replaceChildren(el('p', { class: 'muted', text: 'Loading flag...' }));
  const fail = () => {
    if (shownFlagUrl !== url) return;
    flagCache.delete(url);
    const retry = el('button', { type: 'button', class: 'btn secondary', text: 'Try again' });
    retry.addEventListener('click', () => { shownFlagUrl = null; showFlag(url); });
    box.replaceChildren(el('p', { class: 'error', text: 'Could not load the flag.' }), retry);
  };
  try {
    const src = await loadFlag(url);
    if (shownFlagUrl !== url) return;
    const img = el('img', { class: 'flag-img', src, alt: 'Flag to identify', width: '640', height: '480', decoding: 'async' });
    img.addEventListener('error', fail, { once: true });
    box.replaceChildren(img);
  } catch {
    fail();
  }
}

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
    meta.append(
      el('span', { class: 'spin-category' }, 'Country: ', el('strong', { text: c.name })),
      el('span', { class: 'sr-only', text: ', ' }),
      el('span', { class: 'spin-category' }, 'Category: ', el('strong', { text: q.label })),
    );
  } else {
    meta.append(el('span', { class: 'spin-category' }, 'Category: ', el('strong', { text: q.label })));
  }
  // CR-12: the status note under the country name (not on the outline or flag question, where the country must stay hidden)
  const qStatus = $('q-status');
  qStatus.textContent = q.showCountry ? statusNote(countries[turn.iso3]) : '';
  qStatus.hidden = !qStatus.textContent;
  $('q-prompt').textContent = gameMode(game) === MODE_DISPLAY ? displayPrompt(cat, q.prompt) : q.prompt;

  if (q.outlineUrl) showOutline(q.outlineUrl);
  else { $('q-outline').hidden = true; $('q-outline').replaceChildren(); shownOutlineUrl = null; }
  if (q.flagUrl) showFlag(q.flagUrl);
  else { $('q-flag').hidden = true; $('q-flag').replaceChildren(); shownFlagUrl = null; }

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
  submitAnswer(false);
}

// timedOut: the answer timer ran out (SCHEMA 4.27). Display mode reveals the answer as "Show answer" does; type mode checks what is
// in the boxes as it stands, with no complaint about blank or unreadable boxes (those count as wrong).
function submitAnswer(timedOut) {
  if (!game || stage() !== 'question') return;
  const cat = catById[turn.categoryId];
  const iso3 = turn.iso3;
  if (gameMode(game) === MODE_DISPLAY) {
    stopTimer();
    // "Show answer": reveal it unscored; the players mark Correct or Wrong next (SCHEMA 4.24)
    reveal = { correct: null, expectedText: formatExpected(cat, countries[iso3][cat.id], { countries, iso3 }), given: [], overruled: false, ...(timedOut ? { timedOut: true } : {}) };
    saveGame();
    renderGame();
    renderPlayers();
    return;
  }
  if (timedOut) { stopTimer(); submitTimedOut(cat, iso3); return; }
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
  stopTimer();
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

// Type mode, time is up: whatever is in the boxes is checked normally; an empty or unreadable answer counts as wrong.
function submitTimedOut(cat, iso3) {
  const typed = [...$('q-inputs').querySelectorAll('input[type="text"]')].map((i) => i.value);
  const noColour = [...$('q-inputs').querySelectorAll('input[type="checkbox"]')].map((c) => c.checked);
  const { correct, given } = timeUpAnswer(cat, countries[iso3][cat.id], typed, noColour, { countries, iso3 });
  game = applyResult(game, game.currentPlayer, cat.id, iso3, correct);
  reveal = { correct, expectedText: formatExpected(cat, countries[iso3][cat.id], { countries, iso3 }), given, overruled: false, timedOut: true };
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
  const timeUp = reveal.timedOut ? "Time's up. " : ''; // the answer timer ended this question (SCHEMA 4.27)
  panel.classList.toggle('correct', reveal.correct === true);
  panel.classList.toggle('wrong', reveal.correct === false);
  if (display) {
    // Correct / Wrong are the players' own marks (SCHEMA 4.24): no automatic verdict, no "You answered", no overrule buttons
    $('reveal-title').textContent = timeUp + (pending ? 'The answer' : (reveal.correct ? 'Marked correct' : 'Marked wrong'));
    $('display-marks').hidden = false;
    $('btn-mark-correct').setAttribute('aria-pressed', String(reveal.correct === true));
    $('btn-mark-wrong').setAttribute('aria-pressed', String(reveal.correct === false));
    $('btn-override-correct').hidden = true;
    $('btn-override-wrong').hidden = true;
  } else {
    $('reveal-title').textContent = timeUp + (reveal.overruled
      ? `${reveal.correct ? 'Correct' : 'Wrong'} (overruled)`
      : (reveal.correct ? 'Correct!' : 'Not quite.'));
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
  // Display mode (CR-20, SCHEMA 4.24): the accepted range under the answer, for the numeric categories with a tolerance
  const rangeEl = $('reveal-range');
  rangeEl.textContent = display ? formatRange(cat, c[cat.id]) : '';
  rangeEl.hidden = !rangeEl.textContent;
  renderRankAround(cat, c);
  $('reveal-outcome').textContent = pending
    ? 'Choose Correct or Wrong to carry on.'
    : reveal.correct
      ? `${c.name} is now in ${p.name}'s collection. ${label} is used up for ${p.name}.`
      : `${c.name} stays in the pool. ${label} is used up for ${p.name}.`;
  updateContinueLabel();
  renderReport();
  if (focus) focusSoon($('reveal-title'));
}

// ---- report a wrong answer (SCHEMA 4.28) ----
// An optional inline form under the reveal buttons. It sends the reported answer to a Google Form and never touches the game:
// no player name is sent, Continue works throughout and scoring is unaffected. Hidden when js/report-config.js is empty.

function renderReport() {
  const box = $('report-box');
  box.hidden = !isConfigured(REPORT);
  if (box.hidden) return;
  const key = `${gameToken}:${game.currentPlayer}:${turn.categoryId}:${turn.iso3}`;
  if (reportUi.key !== key) { // a new reveal: a fresh, closed form
    reportUi = { key, state: 'idle', message: '', error: false };
    $('report-reported').value = '';
    $('report-comment').value = '';
    $('report-reported').removeAttribute('aria-invalid');
  }
  const open = reportUi.state === 'open' || reportUi.state === 'sending';
  const sent = reportUi.state === 'sent';
  $('report-form').hidden = !open;
  $('btn-report').setAttribute('aria-expanded', String(open));
  $('btn-report').disabled = sent;
  $('btn-report').textContent = sent ? 'Report sent' : 'Report wrong answer';
  $('btn-report-send').disabled = reportUi.state === 'sending';
  $('report-status').textContent = reportUi.message;
  $('report-status').classList.toggle('error', reportUi.error);
}

function onReportOpen() {
  if (!game || !reveal || stage() !== 'reveal' || reportUi.state === 'sent') return;
  if (reportUi.state === 'idle') { reportUi.state = 'open'; reportUi.message = ''; reportUi.error = false; }
  renderReport();
  $('report-reported').focus();
}

function onReportCancel() {
  if (reportUi.state === 'sending') return;
  if (reportUi.state === 'open') { reportUi.state = 'idle'; reportUi.message = ''; reportUi.error = false; }
  $('report-reported').removeAttribute('aria-invalid');
  renderReport();
  $('btn-report').focus();
}

async function onReportSubmit(e) {
  e.preventDefault();
  if (!game || !reveal || stage() !== 'reveal' || reportUi.state !== 'open') return;
  const cat = catById[turn.categoryId];
  const built = buildPayload({
    iso3: turn.iso3,
    country: countries[turn.iso3].name,
    category: cat.id,
    stored: reveal.expectedText,
    reported: $('report-reported').value,
    comment: $('report-comment').value,
    given: reveal.given.join(', '),
    mode: gameMode(game),
  });
  if (!built.ok) {
    reportUi.message = built.error;
    reportUi.error = true;
    $('report-reported').setAttribute('aria-invalid', 'true');
    renderReport();
    (built.field === 'comment' ? $('report-comment') : $('report-reported')).focus();
    return;
  }
  $('report-reported').removeAttribute('aria-invalid');
  const mine = reportUi; // the player may press Continue while this is on its way: then the result belongs to nobody
  mine.state = 'sending';
  mine.message = 'Sending...';
  mine.error = false;
  renderReport();
  const ok = await sendReport(REPORT, built.values);
  if (reportUi !== mine) return;
  if (ok) {
    mine.state = 'sent';
    mine.message = 'Thanks, your report was sent.';
    renderReport();
    $('report-status').focus();
  } else {
    mine.state = 'open';
    mine.message = 'Could not send. Try again later.';
    mine.error = true;
    renderReport();
    $('btn-report-send').focus();
  }
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

// Military rank. Type mode, a wrong answer: the countries ranked around the number the player typed. Display mode (CR-20, SCHEMA 4.24):
// the country's own place with the one above and below it, the country's own entry highlighted.
function renderRankAround(cat, country) {
  const box = $('reveal-around');
  box.replaceChildren();
  box.hidden = true;
  if (cat.id !== 'militaryRank') return;
  const display = gameMode(game) === MODE_DISPLAY;
  if (!display && reveal.correct) return;
  const rank = display ? country.militaryRank : parseNumber(reveal.given[0], 'militaryRank');
  if (!Number.isInteger(rank)) return;
  const around = militaryNeighbours(countries, rank);
  if (!around.length) return;
  box.append(
    el('p', { class: 'muted', text: display ? `${country.name} is ${rank}:` : `You said ${rank}:` }),
    el('ul', {}, around.map((a) => el('li', { class: a.rank === rank ? 'at' : '' },
      `${a.rank} · `, a.name,
      a.rank === rank && !display ? el('span', { class: 'you', text: ' (your answer)' }) : ''))));
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
  reportUi = { key: null, state: 'idle', message: '', error: false };
  builtQuestionKey = null;
  clearTimerLive();
  if (isGameOver(game)) {
    finishGame();
  } else {
    saveGame();
    renderGame();
    renderPlayers();
    announce(`${game.players[game.currentPlayer].name}'s turn`);
  }
}

// ---- answer timer (SCHEMA 4.27) ----

const qTimer = createTimer({ onTick: renderTimer, onExpire: onTimerExpire });

function renderTimer(snap, milestone) {
  $('timer-text').textContent = snap.text;
  $('timer-fill').style.transform = `scaleX(${snap.fraction})`;
  $('q-timer').classList.toggle('urgent', snap.urgent);
  // announced only at 30 s, 10 s and 0, not every second
  if (milestone !== null) $('timer-live').textContent = milestoneMessage(milestone);
}

function stopTimer() {
  qTimer.stop();
  timerKey = null;
  $('q-timer').hidden = true;
  $('q-timer').classList.remove('urgent');
  // #timer-live is not cleared here: "Time's up" is set just before the timer is stopped and must stay to be announced
}

// Starts the countdown for the question on screen. The announcement text of an earlier run is cleared first, so the same
// words ("30 s left") are announced again.
function startTimer() {
  clearTimerLive();
  qTimer.start();
}

function clearTimerLive() {
  $('timer-live').textContent = '';
}

// Called whenever a screen is drawn. In both modes the countdown starts by itself the first time a question is on screen
// (CR-20: Display mode no longer has a Start timer button). Nothing at all with the timer off.
function syncTimer(st) {
  if (!game || !gameTimer(game) || st !== 'question') { stopTimer(); return; }
  const key = `${gameToken}:${turn.categoryId}:${turn.iso3}`;
  const fresh = timerKey !== key;
  if (fresh) { stopTimer(); timerKey = key; }
  $('q-timer').hidden = false;
  if (fresh) startTimer();
}

function onTimerExpire() {
  if (!game || stage() !== 'question') return;
  submitAnswer(true);
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
  'pool-empty': 'Every country has been won.', // with a region filter renderResults says "in the chosen regions"
  'no-categories': 'Every player has used up all their categories.',
  'all-voted': 'All players voted to end the game.',
};

function finishGame() {
  clearSave();
  gameToken++;
  stopTimer();
  renderResults();
  showScreen('results');
  focusSoon($('results-title'));
}

function renderResults() {
  const rows = ranking(game);
  const reason = endReason(game);
  $('results-reason').textContent = reason === 'pool-empty' && filtersOf(game).regions !== null
    ? 'Every country in the chosen regions has been won.'
    : (END_TEXT[reason] || 'The game is over.');
  const summary = filterSummary(game);
  const dropped = droppedNoteText();
  $('results-filters').textContent = summary ? `Played with: ${summary}.${dropped ? ' ' + dropped : ''}` : '';
  $('results-filters').hidden = !summary;
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

// atHome: the view is the one the map opened on (the whole map, or the chosen regions of a filtered game)
function onZoomChange(z, atHome = z <= MIN_ZOOM + 1e-6) {
  $('zoom-in').setAttribute('aria-disabled', String(z >= MAX_ZOOM - 1e-6));
  $('zoom-out').setAttribute('aria-disabled', String(z <= MIN_ZOOM + 1e-6));
  $('zoom-reset').setAttribute('aria-disabled', String(atHome));
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
  if (empireMap) onZoomChange(empireMap.getZoom(), empireMap.atHome()); else onZoomChange(1);
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
  if (empireMap) onZoomChange(empireMap.getZoom(), empireMap.atHome());
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
  const scopeNote = $('empires-scope');
  const scopeRegions = filtersOf(game).regions;
  scopeNote.textContent = scopeRegions ? `The game was played in ${scopeRegions.join(', ')}. The other countries are dimmed.` : '';
  scopeNote.hidden = !scopeRegions;
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
    // A region filter (SCHEMA 4.26): the map opens on the chosen regions, and the countries outside them are dimmer.
    const regions = filtersOf(game).regions;
    const isos = Object.keys(countries);
    const outside = regions ? new Set(isos.filter((iso3) => !inScope(game, iso3))) : null;
    const frame = regions ? framingView(wm, isos.filter((iso3) => inScope(game, iso3))) : null;
    empireMap = createEmpireMap(box, {
      worldmap: wm, players: game.players, nameOf: (iso3) => countries[iso3].name, statusOf: (iso3) => statusNote(countries[iso3]),
      onZoom: onZoomChange, outside, frame, scope: regions ? regions.join(', ') : '',
    });
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

  initSetupFilters();
  catWheel = createWheel($('canvas-cat'));

  $('btn-add-player').addEventListener('click', () => {
    if (setupNames.length >= MAX_PLAYERS) return;
    setupNames.push('');
    setupColours.push(randomUnusedColour(setupColours));
    renderSetup(setupNames.length - 1);
  });
  $('opt-cats').addEventListener('change', () => onFilterToggle('catsOn', 'opt-cats', 'cats-panel'));
  $('opt-regions').addEventListener('change', () => onFilterToggle('regsOn', 'opt-regions', 'regions-panel'));
  $('cats-packs').addEventListener('click', (e) => { const b = e.target.closest('button[data-pack]'); if (b) { if (b.dataset.pack === CUSTOM_PACK_ID) onCustomPress(); else onPackPress(b.dataset.pack); } });
  $('cats-toggle').addEventListener('click', () => setCatsListOpen(!catsListOpen));
  $('regions-all').addEventListener('click', () => onFilterAll(setupFilters.regs, REGIONS, 'regions-list'));
  $('regions-none').addEventListener('click', () => onFilterNone(setupFilters.regs, 'regions-list'));
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
  $('opt-timer').addEventListener('change', () => { setupTimer = $('opt-timer').checked; });
  $('opt-skip').addEventListener('change', () => { setupSkipSpin = $('opt-skip').checked; });
  // a background tab may throttle the poll: look at the real time as soon as the tab is back
  document.addEventListener('visibilitychange', () => qTimer.check());
  $('btn-continue').addEventListener('click', onContinue);
  $('btn-report').addEventListener('click', onReportOpen);
  $('btn-report-cancel').addEventListener('click', onReportCancel);
  $('report-form').addEventListener('submit', onReportSubmit);
  $('report-form').addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); onReportCancel(); } });
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
  $('btn-play-again').addEventListener('click', () => {
    const f = filtersOf(game); // the same regions and categories again
    startGame(game.players.map((p) => p.name), gameMode(game), game.players.map((p) => p.colour), { regions: f.regions, categories: f.categories }, gameTimer(game), gameSkipSpin(game));
  });

  goToSetup();
  focusSoon(null);
}

init();
