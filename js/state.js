// Pure game-state logic for the hot-seat Geo Game.
// No DOM, no dependencies. Every function returns new state and never mutates its inputs.
//
// State shape:
//   {
//     players: [{ name, colour, set: iso3[], remainingCategories: categoryId[], voteEnd: boolean }],
//                        // colour: id of one of the 8 PALETTE colours, never shared by two players (SCHEMA 4.25)
//     pool: iso3[],            // countries nobody has won yet
//     currentPlayer: number,   // index into players
//     phase: 'playing' | 'ended',
//     round: number,           // starts at 1, +1 each time play wraps to the first active player
//     endReason: null | 'pool-empty' | 'no-categories' | 'all-voted',
//     mode: 'type' | 'display',  // answer mode, fixed for the whole game (SCHEMA 4.24); a state without it is 'type'
//     filters: { regions: string[] | null, categories: string[] | null, dropped: string[] },
//                        // optional setup filters (SCHEMA 4.26, CR-15): regions = the chosen regions (null = whole world),
//                        // categories = the categories every player starts with (null = all of them), dropped = chosen
//                        // categories that had no data for the pool and were left out; a state without it has no filters
//     timer: boolean,    // the 60-second answer timer (SCHEMA 4.27, CR-16), default true; a state without it has the timer on
//     skipSpin: boolean, // both wheels land at once with no animation (SCHEMA 4.29, CR-20), default false; a state without it is false
//     countries: object        // the countries.json object, shared by reference, treated as read-only
//   }
//
// Null rule (SCHEMA 2.2): a category is only askable for countries whose value is non-null.
// A category with no such country left in the pool is unavailable.

export const END_POOL_EMPTY = 'pool-empty';
export const END_NO_CATEGORIES = 'no-categories';
export const END_ALL_VOTED = 'all-voted';

export const MODE_TYPE = 'type';
export const MODE_DISPLAY = 'display';
export const ANSWER_MODES = [MODE_TYPE, MODE_DISPLAY];

/** The answer mode of a game state (or a saved game): 'display' only when it says so, otherwise 'type' (old saves have no mode). */
export function gameMode(state) {
  return state && state.mode === MODE_DISPLAY ? MODE_DISPLAY : MODE_TYPE;
}

/** True when a saved mode value is usable: absent (an old save, loads as 'type') or one of the two modes. */
export function validMode(mode) {
  return mode === undefined || ANSWER_MODES.includes(mode);
}

/** True when the game has the 60-second answer timer (SCHEMA 4.27): on unless the state says `timer: false` (old saves have none, so on). */
export function gameTimer(state) {
  return !(state && state.timer === false);
}

/** True when a saved timer value is usable: absent (an old save, loads as on) or a boolean. */
export function validTimer(timer) {
  return timer === undefined || typeof timer === 'boolean';
}

/** True when the game skips the wheel animation (SCHEMA 4.29): only when the state says `skipSpin: true` (old saves have none, so off). */
export function gameSkipSpin(state) {
  return !!state && state.skipSpin === true;
}

/** True when a saved skipSpin value is usable: absent (loads as off) or a boolean. */
export function validSkipSpin(skipSpin) {
  return skipSpin === undefined || typeof skipSpin === 'boolean';
}

// ---------------------------------------------------------------------------
// Player colours (SCHEMA 4.25, CR-11). Eight fixed colours; each player holds one, no two players share one.
// Hex values were checked as a set on the panel colour #1b2030 (dataviz validator, dark mode).
// ---------------------------------------------------------------------------

export const PALETTE = [
  { id: 'blue', name: 'Blue', hex: '#3987e5' },
  { id: 'orange', name: 'Orange', hex: '#d95926' },
  { id: 'aqua', name: 'Aqua', hex: '#199e70' },
  { id: 'yellow', name: 'Yellow', hex: '#c98500' },
  { id: 'magenta', name: 'Magenta', hex: '#d55181' },
  { id: 'green', name: 'Green', hex: '#008300' },
  { id: 'violet', name: 'Violet', hex: '#9085e9' },
  { id: 'red', name: 'Red', hex: '#e66767' },
];
export const NEUTRAL_HEX = '#3a4152';
export const PANEL_HEX = '#1b2030';

/** The palette entry for a colour id, or undefined. */
export function colourOf(id) {
  return PALETTE.find((c) => c.id === id);
}

/** True when id is one of the 8 palette ids. */
export function validColour(id) {
  return typeof id === 'string' && PALETTE.some((c) => c.id === id);
}

/** Hex for a colour id; the neutral grey for anything that is not a palette id. */
export function colourHex(id) {
  const c = colourOf(id);
  return c ? c.hex : NEUTRAL_HEX;
}

/** Palette ids not in the list `used`. */
export function unusedColours(used) {
  return PALETTE.map((c) => c.id).filter((id) => !used.includes(id));
}

/** A random palette id not in `used`, or undefined when all 8 are taken. rng returns [0, 1). */
export function randomUnusedColour(used, rng = Math.random) {
  return pickRandom(unusedColours(used), rng);
}

/** n distinct random palette ids (n <= 8; extra players get nothing and are not allowed by the UI). */
export function randomColours(n, rng = Math.random) {
  const out = [];
  for (let i = 0; i < Math.min(n, PALETTE.length); i++) out.push(randomUnusedColour(out, rng));
  return out;
}

/** True when another player (any index but exceptIndex) already holds `id`. */
export function isColourTaken(colours, id, exceptIndex = -1) {
  return colours.some((c, i) => i !== exceptIndex && c === id);
}

/**
 * Give player `idx` the colour `id`. Returns a new array, or the same array when that is not allowed:
 * not a palette colour, or already held by another player (two players can never share a colour).
 */
export function changeColour(colours, idx, id) {
  if (!validColour(id) || idx < 0 || idx >= colours.length || isColourTaken(colours, id, idx)) return colours;
  const out = colours.slice();
  out[idx] = id;
  return out;
}

/**
 * The colour ids for n players: the ones given when they are valid palette ids and all different, otherwise
 * (an old save, a bad value, a repeat of an earlier player's colour) each failing player gets the first unused colour in palette order.
 */
export function fillColours(given, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = Array.isArray(given) ? given[i] : undefined;
    out.push(validColour(c) && !out.includes(c) ? c : null);
  }
  for (let i = 0; i < n; i++) {
    if (out[i] === null) out[i] = unusedColours(out)[0] ?? null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Setup filters (SCHEMA 4.26, CR-15): play with only some categories and/or only some regions.
// A filters value is { regions: string[] | null, categories: string[] | null }: null = no limit (whole world / all categories).
// ---------------------------------------------------------------------------

export const REGIONS = ['Africa', 'Americas', 'Asia', 'Europe', 'Oceania'];
export const NO_FILTERS = Object.freeze({ regions: null, categories: null, dropped: Object.freeze([]) });

/** { Africa: n, ... } number of countries per region (every region of REGIONS is a key). */
export function regionCounts(countries) {
  const out = Object.fromEntries(REGIONS.map((r) => [r, 0]));
  for (const iso3 of Object.keys(countries)) {
    const r = countries[iso3] && countries[iso3].region;
    if (Object.hasOwn(out, r)) out[r]++;
  }
  return out;
}

const categoryIdOf = (c) => (typeof c === 'string' ? c : c.id);

/**
 * Works out a game from the setup choices (pure; createGame uses it, and the setup screen calls it to show errors).
 * `filters` = { regions, categories } as ticked on the setup screen (null or missing = no limit).
 * Returns { ok: true, pool, categoryIds, filters: { regions, categories, dropped }, dropped } or { ok: false, error, message }
 * where error is 'regions' (none chosen), 'categories' (none chosen) or 'no-data' (every chosen category lacks data for the pool).
 * Unknown region names and category ids are ignored. A choice of all 5 regions is stored as null; a choice of all categories is
 * stored as null unless some were dropped for having no data, in which case the explicit list that is left is stored.
 */
export function planGame(countries, categories, filters = null) {
  const allIds = categories.map(categoryIdOf);
  const f = filters || {};
  let regions = null;
  if (Array.isArray(f.regions)) {
    regions = REGIONS.filter((r) => f.regions.includes(r));
    if (regions.length === 0) return { ok: false, error: 'regions', message: 'Choose at least one region.' };
    if (regions.length === REGIONS.length) regions = null;
  }
  let chosen = allIds;
  let restricted = false;
  if (Array.isArray(f.categories)) {
    chosen = allIds.filter((id) => f.categories.includes(id));
    if (chosen.length === 0) return { ok: false, error: 'categories', message: 'Choose at least one category.' };
    restricted = chosen.length < allIds.length;
  }
  const pool = Object.keys(countries)
    .filter((iso3) => regions === null || regions.includes(countries[iso3].region))
    .sort();
  // Without a filter nothing is dropped (a category nobody has data for is simply never offered, see availableCategories).
  const dropped = regions === null && !restricted ? [] : chosen.filter((id) => !pool.some((iso3) => hasData(countries[iso3], id)));
  const kept = chosen.filter((id) => !dropped.includes(id));
  if (kept.length === 0 && (regions !== null || restricted)) {
    return { ok: false, error: 'no-data', message: 'None of the chosen categories has data for these countries. Choose other categories or regions.' };
  }
  return {
    ok: true,
    pool,
    categoryIds: kept,
    dropped,
    filters: { regions, categories: restricted || dropped.length ? kept : null, dropped },
  };
}

/** The filters of a game state (or a saved game); NO_FILTERS when it has none (an old save). */
export function filtersOf(state) {
  return state && state.filters ? state.filters : NO_FILTERS;
}

/** True when a game has a region or category filter. */
export function hasFilters(state) {
  const f = filtersOf(state);
  return f.regions !== null || f.categories !== null;
}

/** True when the country belongs to the game's regions (always true without a region filter). */
export function inScope(state, iso3, countries = state.countries) {
  const f = filtersOf(state);
  return f.regions === null || (countries[iso3] != null && f.regions.includes(countries[iso3].region));
}

/** Short text for the game header, e.g. "Europe · 8 categories" or "Asia, Europe"; '' when there is no filter. */
export function filterSummary(state) {
  const f = filtersOf(state);
  const parts = [];
  if (f.regions !== null) parts.push(f.regions.length <= 2 ? f.regions.join(', ') : `${f.regions.length} regions`);
  if (f.categories !== null) parts.push(`${f.categories.length} ${f.categories.length === 1 ? 'category' : 'categories'}`);
  return parts.join(' · ');
}

/**
 * Checks a saved filters value against the data. Returns the filters to use ({ regions, categories, dropped }), NO_FILTERS for a save
 * with none (before 1.16), or null when it is unusable (wrong types, unknown or repeated names, an empty list).
 */
export function parseFilters(raw, countries, categoryIds) {
  if (raw === undefined) return NO_FILTERS;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const list = (v, known) => v === null || (Array.isArray(v) && v.length > 0 && v.every((x) => known.includes(x)) && new Set(v).size === v.length);
  if (!list(raw.regions, REGIONS) || !list(raw.categories, categoryIds)) return null;
  if (raw.regions !== null && raw.regions.length === REGIONS.length) return null; // all regions are stored as null
  if (!Array.isArray(raw.dropped) || !raw.dropped.every((x) => categoryIds.includes(x)) || new Set(raw.dropped).size !== raw.dropped.length) return null;
  if (raw.categories !== null && raw.dropped.some((x) => raw.categories.includes(x))) return null;
  if (raw.dropped.length && raw.categories === null) return null;
  return { regions: raw.regions, categories: raw.categories, dropped: raw.dropped.slice() };
}

/** Random element of list, or undefined if the list is empty. rng returns [0, 1). */
export function pickRandom(list, rng = Math.random) {
  if (!list || list.length === 0) return undefined;
  const i = Math.min(Math.floor(rng() * list.length), list.length - 1);
  return list[i];
}

/** Value is "present" when it is neither null nor undefined (SCHEMA 2.2: missing data is null). */
function hasData(country, categoryId) {
  return country != null && country[categoryId] != null;
}

function copyPlayer(p) {
  return {
    name: p.name,
    colour: p.colour,
    set: p.set.slice(),
    remainingCategories: p.remainingCategories.slice(),
    voteEnd: p.voteEnd,
  };
}

function withPlayers(state, players, extra = {}) {
  return { ...state, players, ...extra };
}

/**
 * Start a game.
 * @param {string[]} playerNames
 * @param {object} countries countries.json object keyed by iso3
 * @param {Array<{id:string}|string>} categories categories.json array (objects with id, or plain ids)
 * @param {'type'|'display'} [mode] answer mode (SCHEMA 4.24), 'type' unless 'display' is asked for
 * @param {string[]} [colours] colour id per player (SCHEMA 4.25); missing or invalid entries are filled in palette order
 * @param {{regions: string[]|null, categories: string[]|null}} [filters] setup filters (SCHEMA 4.26): the pool is the countries of
 *   the chosen regions and every player starts with the chosen categories that have data for that pool (see planGame); throws
 *   when the choice is empty or leaves no category
 * @param {boolean} [timer] the answer timer (SCHEMA 4.27), on unless false
 * @param {boolean} [skipSpin] both wheels land with no animation (SCHEMA 4.29), off unless true
 */
export function createGame(playerNames, countries, categories, mode = MODE_TYPE, colours = undefined, filters = null, timer = true, skipSpin = false) {
  if (!Array.isArray(playerNames) || playerNames.length < 1) {
    throw new Error('createGame needs at least one player');
  }
  const plan = planGame(countries, categories, filters);
  if (!plan.ok) throw new Error(plan.message);
  const ids = plan.categoryIds;
  const pool = plan.pool;
  const own = fillColours(colours, playerNames.length);
  const state = {
    players: playerNames.map((name, i) => ({
      name,
      colour: own[i],
      set: [],
      remainingCategories: ids.slice(),
      voteEnd: false,
    })),
    pool,
    currentPlayer: 0,
    phase: 'playing',
    round: 1,
    endReason: null,
    mode: mode === MODE_DISPLAY ? MODE_DISPLAY : MODE_TYPE,
    filters: plan.filters,
    timer: timer !== false,
    skipSpin: skipSpin === true,
    countries,
  };
  return finalize(state);
}

/** Pool countries with non-null data for categoryId. */
export function eligibleCountries(state, categoryId, countries = state.countries) {
  return state.pool.filter((iso3) => hasData(countries[iso3], categoryId));
}

/** The player's remaining categories that still have at least one eligible country in the pool. */
export function availableCategories(state, playerIdx, countries = state.countries) {
  const player = state.players[playerIdx];
  if (!player) return [];
  return player.remainingCategories.filter((id) =>
    state.pool.some((iso3) => hasData(countries[iso3], id))
  );
}

/** True when the player has at least one available category. */
export function isActive(state, playerIdx, countries = state.countries) {
  return availableCategories(state, playerIdx, countries).length > 0;
}

/**
 * Record a turn result. The category is used up for that player either way.
 * If correct, iso3 moves from the pool into the player's set.
 * Returns the state unchanged once the game has ended. Throws on a bad player index, a category
 * not in the player's remaining list, a country not in the pool, or a country with null data
 * for the category (such a question must never be asked, SCHEMA 2.2).
 */
export function applyResult(state, playerIdx, categoryId, iso3, correct) {
  const player = state.players[playerIdx];
  if (!player) throw new Error('No such player: ' + playerIdx);
  if (isGameOver(state)) return state;
  if (!player.remainingCategories.includes(categoryId)) {
    throw new Error(`Category ${categoryId} is not in player ${playerIdx}'s remaining list`);
  }
  if (!state.pool.includes(iso3)) throw new Error(`Country ${iso3} is not in the pool`);
  if (!hasData(state.countries[iso3], categoryId)) {
    throw new Error(`Country ${iso3} has no data for category ${categoryId}`);
  }
  const players = state.players.map(copyPlayer);
  const p = players[playerIdx];
  p.remainingCategories = p.remainingCategories.filter((id) => id !== categoryId);
  let pool = state.pool;
  if (correct) {
    p.set.push(iso3);
    pool = pool.filter((c) => c !== iso3);
  }
  return finalize(withPlayers(state, players, { pool }));
}

/**
 * Overrule the result of the answer just given (the players disagree with the automatic check).
 * Call it on the state returned by applyResult, before nextPlayer. correct = true moves iso3 from the pool into the
 * player's set; correct = false moves it back to the pool. The category stays used up either way. Asking for the
 * result the state already has returns the state unchanged, so it can never be applied twice, and asking for the
 * opposite undoes the earlier override. The end conditions are re-evaluated: a game that ended because the pool
 * emptied (or no category was left) is running again if the override changes that, and the reverse.
 * Throws on a bad player index, or a country that is neither in the pool nor in that player's set.
 */
export function overrideResult(state, playerIdx, iso3, correct) {
  const player = state.players[playerIdx];
  if (!player) throw new Error('No such player: ' + playerIdx);
  const inSet = player.set.includes(iso3);
  const inPool = state.pool.includes(iso3);
  if (!inSet && !inPool) throw new Error(`Country ${iso3} is in neither the pool nor player ${playerIdx}'s set`);
  if (!!correct === inSet) return state;
  const players = state.players.map(copyPlayer);
  let pool;
  if (correct) {
    players[playerIdx].set.push(iso3);
    pool = state.pool.filter((c) => c !== iso3);
  } else {
    players[playerIdx].set = players[playerIdx].set.filter((c) => c !== iso3);
    pool = [...state.pool, iso3].sort();
  }
  let out = withPlayers(state, players, { pool });
  // An end caused by the pool or the categories is lifted, then finalize() ends the game again if it still applies.
  if (out.phase === 'ended' && (out.endReason === END_POOL_EMPTY || out.endReason === END_NO_CATEGORIES)) {
    out = { ...out, phase: 'playing', endReason: null };
  }
  return finalize(out);
}

/**
 * Display mode (SCHEMA 4.24): the players say the answer, see it, then mark it Correct or Wrong. Nothing is scored until
 * the first mark: scored = false applies the mark exactly as applyResult would; scored = true (the mark is being changed
 * before Continue) is overrideResult. Either way the state ends up as if the chosen result had been scored.
 */
export function applyDisplayResult(state, playerIdx, categoryId, iso3, correct, scored) {
  return scored
    ? overrideResult(state, playerIdx, iso3, correct)
    : applyResult(state, playerIdx, categoryId, iso3, correct);
}

/** Display mode: Continue is allowed only once Correct or Wrong has been chosen (reveal.correct is then a boolean). */
export function canContinue(reveal) {
  return !!reveal && typeof reveal.correct === 'boolean';
}

/** Set or clear a player's vote to end the game. Returns the state unchanged once the game has ended. */
export function setVote(state, playerIdx, bool) {
  if (!state.players[playerIdx]) throw new Error('No such player: ' + playerIdx);
  if (isGameOver(state)) return state;
  const players = state.players.map(copyPlayer);
  players[playerIdx].voteEnd = !!bool;
  return withPlayers(state, players);
}

// Reason from the live state (pool / categories), ignoring votes.
function liveEndReason(state) {
  if (state.pool.length === 0) return END_POOL_EMPTY;
  const anyActive = state.players.some((_, i) => isActive(state, i));
  if (!anyActive) return END_NO_CATEGORIES;
  return null;
}

// Mark the game ended if pool/categories say so. Votes are only checked at round end (nextPlayer).
function finalize(state) {
  if (state.phase === 'ended') return state;
  const reason = liveEndReason(state);
  if (reason) return { ...state, phase: 'ended', endReason: reason };
  return state;
}

/**
 * Advance to the next player who has an available category, skipping finished players.
 * When play wraps past the last player (a full round is complete), the game ends if every
 * active player has voted to end. Players with no available category are finished and do not
 * need to vote.
 */
export function nextPlayer(state) {
  if (isGameOver(state)) return finalize(state);
  const n = state.players.length;
  let next = -1;
  let wrapped = false;
  for (let k = 1; k <= n; k++) {
    const idx = (state.currentPlayer + k) % n;
    if (isActive(state, idx)) {
      next = idx;
      wrapped = state.currentPlayer + k >= n;
      break;
    }
  }
  // finalize() guarantees an active player exists while the game is running.
  if (next === -1) return { ...state, phase: 'ended', endReason: END_NO_CATEGORIES };
  let out = { ...state, currentPlayer: next };
  if (wrapped) {
    out.round = state.round + 1;
    const active = state.players.map((_, i) => i).filter((i) => isActive(state, i));
    if (active.every((i) => state.players[i].voteEnd)) {
      out = { ...out, phase: 'ended', endReason: END_ALL_VOTED };
    }
  }
  return out;
}

export function isGameOver(state) {
  return state.phase === 'ended' || liveEndReason(state) !== null;
}

/** null while the game is running, otherwise 'pool-empty' | 'no-categories' | 'all-voted'. */
export function endReason(state) {
  if (state.phase === 'ended' && state.endReason) return state.endReason;
  return liveEndReason(state);
}

/**
 * Players sorted by number of countries, highest first. Ties share a rank (1, 1, 3).
 * Equal scores keep player order.
 */
export function ranking(state) {
  const rows = state.players
    .map((p, playerIndex) => ({
      playerIndex,
      name: p.name,
      colour: p.colour,
      count: p.set.length,
      countries: p.set.slice(),
    }))
    .sort((a, b) => b.count - a.count || a.playerIndex - b.playerIndex);
  let rank = 0;
  return rows.map((row, i) => {
    if (i === 0 || row.count !== rows[i - 1].count) rank = i + 1;
    return { rank, ...row };
  });
}
