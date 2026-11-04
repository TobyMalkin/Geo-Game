// Answer checking for the Geo Game, per data/SCHEMA.md v1.4.
// Pure ES module: no DOM, no dependencies.
//
// checkAnswer(category, value, input, ctx) -> { status: 'correct'|'wrong'|'invalid', expected, parsed? }
//   category: entry of categories.json
//   value:    the country's stored value for that category (must be non-null; the game re-spins nulls)
//   input:    raw player string, or string[] for multi-input categories
//   ctx:      { countries, iso3 }  countries = countries.json object (neighbours, outline),
//                                  iso3 = the answer country (outline)
// 'invalid' = the input could not be understood (the UI asks again); it is not a wrong answer.

/** militaryRank is 1..197: the 193 UN member states plus PSE, VAT, TWN and XKX (SCHEMA 1.15). */
export const MAX_MILITARY_RANK = 197;

// ---------------------------------------------------------------------------
// 4.0 Text matching
// ---------------------------------------------------------------------------

/**
 * Unicode NFD, strip marks, lowercase, delete dots and apostrophes ("U.S.A." -> "usa"), & -> and,
 * other non letter/digit -> space, collapse, drop leading "the".
 */
export function normalise(text) {
  let s = String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[.'‘’ʼʻ`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (s.startsWith('the ') && s.length > 4) s = s.slice(4);
  return s;
}

export function levenshtein(a, b) {
  const x = Array.from(a);
  const y = Array.from(b);
  if (x.length === 0) return y.length;
  if (y.length === 0) return x.length;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[y.length];
}

/** Set of every normalised country name and alias in a countries.json object (the typo guard). */
export function countryNameGuard(countries) {
  const set = new Set();
  for (const c of Object.values(countries || {})) {
    for (const n of [c.name, ...(c.aliases || [])]) {
      const k = normalise(n);
      if (k) set.add(k);
    }
  }
  return set;
}

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii']);

function candidatesOf(answer, surname) {
  const names = typeof answer === 'string' ? [answer] : [answer.name, ...(answer.aliases || [])];
  const out = names.map(normalise).filter((s) => s.length > 0);
  if (surname) {
    const full = typeof answer === 'string' ? answer : answer.name;
    const tokens = normalise(full).split(' ');
    while (tokens.length > 1 && NAME_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
    const last = tokens[tokens.length - 1];
    if (tokens.length > 1 && last.length >= 3) out.push(last);
  }
  return out;
}

// { exact, near }: indices matched exactly, and indices matched only by the fuzzy rule
// (Levenshtein <= 1 against an accepted answer of 6+ normalised characters).
// Simple English plurals of an accepted answer (CR-7 carry-over): beer -> beers, wine -> wines, glass -> glasses, berry -> berries,
// knife -> knives. Only used when a category opts in (opts.plural); never for names of people, places or codes.
export function pluralForms(c) {
  if (c.length < 3) return [];
  const forms = [c + 's'];
  if (/(?:s|x|z|ch|sh|o)$/.test(c)) forms.push(c + 'es');
  if (/[^aeiou]y$/.test(c)) forms.push(c.slice(0, -1) + 'ies');
  if (/fe$/.test(c)) forms.push(c.slice(0, -2) + 'ves');
  else if (/f$/.test(c)) forms.push(c.slice(0, -1) + 'ves');
  return forms;
}

function matchDetail(input, answers, opts = {}) {
  const { fuzzy = true, surname = false, guard = null, plural = false } = opts;
  const q = normalise(input);
  const exact = [];
  const near = [];
  if (q === '') return { exact, near };
  // Country typo guard (SCHEMA 4.0 rule 5): an input that is exactly some country's name or alias
  // is never treated as a typo of another one.
  const allowFuzzy = fuzzy && !(guard && guard.has(q));
  answers.forEach((answer, i) => {
    const cands = candidatesOf(answer, surname);
    if (cands.includes(q)) exact.push(i);
    else if (plural && cands.some((c) => pluralForms(c).includes(q))) exact.push(i);
    else if (allowFuzzy && cands.some((c) => c.length >= 6 && levenshtein(q, c) <= 1)) near.push(i);
  });
  return { exact, near };
}

/**
 * Indices of all answers matched by input, exact and fuzzy together, in list order.
 * opts: { fuzzy = true, surname = false, plural = false, guard } where guard is a Set of normalised country names
 * (see countryNameGuard) that must never be fuzzy-matched, and plural accepts a simple English plural of an answer (pluralForms).
 */
export function matchingIndices(input, answers, opts = {}) {
  const { exact, near } = matchDetail(input, answers, opts);
  return exact.concat(near).sort((x, y) => x - y);
}

/**
 * Index of the first answer matching input (an exact match is preferred over a fuzzy one), or -1.
 * answers: Answer[] (string | {name, aliases}). opts: { fuzzy, surname, exclude: indices to skip }.
 */
export function matchAnswer(input, answers, opts = {}) {
  const exclude = new Set(opts.exclude || []);
  const { exact, near } = matchDetail(input, answers, opts);
  const hits = exact.filter((i) => !exclude.has(i)).concat(near.filter((i) => !exclude.has(i)));
  return hits.length ? hits[0] : -1;
}

// Size of a maximum matching between pieces and answer indices (pieces[i] -> allowed[i] indices).
function maxMatching(allowed) {
  const owner = new Map(); // answer index -> piece index
  const tryPiece = (p, seen) => {
    for (const a of allowed[p]) {
      if (seen.has(a)) continue;
      seen.add(a);
      if (!owner.has(a) || tryPiece(owner.get(a), seen)) {
        owner.set(a, p);
        return true;
      }
    }
    return false;
  };
  let size = 0;
  for (let p = 0; p < allowed.length; p++) if (tryPiece(p, new Set())) size++;
  return { size, owner };
}

// ---------------------------------------------------------------------------
// Splitting multi-item input
// ---------------------------------------------------------------------------

const SPLITTER = /,|&|\/|\n|\r|\band\b/i;

function splitPieces(input) {
  const raw = Array.isArray(input) ? input : [input];
  const out = [];
  for (const r of raw) {
    for (const piece of String(r ?? '').split(SPLITTER)) {
      if (piece.trim() !== '') out.push(piece.trim());
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4.1 Numeric input
// ---------------------------------------------------------------------------

const SUFFIX_CATEGORIES = new Set(['population', 'gdpPerCapita', 'area']);
const SUFFIX_EXP = { k: 3, m: 6, bn: 9 };

function parsePlainNumber(text, allowSuffix) {
  let t = String(text ?? '').trim().toLowerCase();
  t = t.replace(/^\p{Sc}\s*/u, '').replace(/\s*%$/, '').trim();
  let exp = 0;
  if (allowSuffix) {
    const m = t.match(/^(.*?)\s*(bn|k|m)$/);
    if (m) {
      t = m[1].trim();
      exp = SUFFIX_EXP[m[2]];
    }
  }
  if (t === '' || !/^[\d.,]+$/.test(t)) return null;
  let num;
  if (t.includes('.')) {
    num = t.replace(/,/g, '');
  } else {
    const m = t.match(/^(.*),(\d{1,2})$/);
    num = m ? m[1].replace(/,/g, '') + '.' + m[2] : t.replace(/,/g, '');
  }
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(num)) return null;
  const n = Number(`${num}e${exp}`);
  return Number.isFinite(n) ? n : null;
}

/** Height in inches from "70", "69.5", 5'10", 5'10, 5ft10, 5 ft 10 in. null if invalid. */
export function parseHeight(text) {
  const t = String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[‘’′´`]/g, "'")
    .replace(/[“”″]/g, '"');
  const m = t.match(
    /^(\d+(?:\.\d+)?)\s*(?:'|ft|feet|foot)\s*(?:(\d+(?:\.\d+)?)\s*(?:''|"|in|inch|inches)?)?$/
  );
  if (m) {
    const feet = Number(m[1]);
    const inches = m[2] === undefined ? 0 : Number(m[2]);
    if (inches >= 12) return null; // 5'14 is not a height
    return Math.round((feet * 12 + inches) * 1e6) / 1e6;
  }
  return parsePlainNumber(t, false);
}

/** Minutes from "150", "2:30", "2h30", "2h 30m", "2h", "90m", "90 min", "2.5h". null if invalid. */
export function parseFlightTime(text) {
  const t = String(text ?? '').trim().toLowerCase();
  const round = (n) => Math.round(n * 1e6) / 1e6;
  let m;
  if ((m = t.match(/^(\d+(?:\.\d+)?)$/))) return round(Number(m[1]));
  if ((m = t.match(/^(\d+):(\d{2})$/))) {
    return Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null;
  }
  if (
    (m = t.match(
      /^(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\s*(?:(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)?)?$/
    ))
  ) {
    const mins = m[2] === undefined ? 0 : Number(m[2]);
    if (mins >= 60) return null; // "2h 90" is not a time
    return round(Number(m[1]) * 60 + mins);
  }
  if ((m = t.match(/^(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)$/))) return round(Number(m[1]));
  return null;
}

/**
 * Parse a numeric answer for a category id. Returns a number, or null when invalid.
 * k/m/bn suffixes only for population, gdpPerCapita, area. militaryRank: integers only.
 */
export function parseNumber(text, categoryId) {
  if (categoryId === 'maleHeight') return parseHeight(text);
  if (categoryId === 'flightTime') return parseFlightTime(text);
  if (categoryId === 'highestPoint') {
    // metres: a plain number, an optional unit word or letter after it ("4806", "4,806 m", "4806 metres"); no k / m / bn suffixes
    return parsePlainNumber(String(text ?? '').trim().toLowerCase().replace(/\s*(?:metres|meters|metre|meter|m)$/, ''), false);
  }
  if (categoryId === 'militaryRank') {
    const t = String(text ?? '').trim();
    if (!/^\d+$/.test(t)) return null;
    const n = Number(t);
    return n >= 1 && n <= MAX_MILITARY_RANK ? n : null; // ranks are 1..197 (CR-12: 193 UN states + PSE, VAT, TWN, XKX)
  }
  return parsePlainNumber(text, SUFFIX_CATEGORIES.has(categoryId));
}

// ---------------------------------------------------------------------------
// 4.11 Flag colours (SCHEMA 1.8: n rows, each a colour box or ticked "No colour")
// ---------------------------------------------------------------------------

export const COLOUR_VOCABULARY = ['red', 'orange', 'yellow', 'green', 'blue', 'white', 'black', 'brown', 'purple'];

const COLOUR_ALIASES = {
  gold: 'yellow', golden: 'yellow', amber: 'yellow',
  navy: 'blue', azure: 'blue', cyan: 'blue', turquoise: 'blue',
  'dark blue': 'blue', 'light blue': 'blue', 'sky blue': 'blue',
  maroon: 'red', burgundy: 'red', crimson: 'red', scarlet: 'red', 'dark red': 'red',
  violet: 'purple',
};
for (const c of COLOUR_VOCABULARY) COLOUR_ALIASES[c] = c;
const MULTI_WORD_TERMS = Object.keys(COLOUR_ALIASES).filter((k) => k.includes(' '));
const MAX_TERM_WORDS = Math.max(1, ...MULTI_WORD_TERMS.map((k) => k.split(' ').length));
const COLOUR_MODIFIERS = new Set(['light', 'dark', 'pale', 'bright', 'deep', 'royal']);
const COLOUR_FILLERS = new Set(['the', 'a']);

/**
 * Colours (vocabulary words, de-duplicated, in input order) from raw text or a string[].
 * Returns null when invalid (unknown word, or no colour at all).
 */
export function parseColours(input) {
  const raw = Array.isArray(input) ? input.join('\n') : String(input ?? '');
  const found = [];
  for (const piece of raw.split(SPLITTER)) {
    const words = piece
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .split(/\s+/)
      .filter((w) => w !== '');
    let i = 0;
    while (i < words.length) {
      let matched = false;
      for (let len = Math.min(MAX_TERM_WORDS, words.length - i); len >= 2; len--) {
        const term = words.slice(i, i + len).join(' ');
        if (MULTI_WORD_TERMS.includes(term)) {
          found.push(COLOUR_ALIASES[term]);
          i += len;
          matched = true;
          break;
        }
      }
      if (matched) continue;
      const w = words[i];
      if (COLOUR_ALIASES[w]) found.push(COLOUR_ALIASES[w]);
      else if (!COLOUR_MODIFIERS.has(w) && !COLOUR_FILLERS.has(w)) return null;
      i++;
    }
  }
  const colours = [...new Set(found)];
  return colours.length ? colours : null;
}

// ---------------------------------------------------------------------------
// 4.19 Religion
// ---------------------------------------------------------------------------

export const RELIGIONS = {
  Christianity: ['Christian', 'Catholic', 'Catholicism', 'Roman Catholic', 'Orthodox', 'Eastern Orthodox', 'Protestant', 'Protestantism', 'Anglican', 'Lutheran', 'Evangelical'],
  Islam: ['Muslim', 'Islamic', 'Sunni', 'Shia', 'Shiite', 'Sunni Islam', 'Shia Islam'],
  Hinduism: ['Hindu'],
  Buddhism: ['Buddhist', 'Theravada', 'Mahayana'],
  Judaism: ['Jewish', 'Jew'],
  Shinto: ['Shintoism'],
  'Folk religion': ['Folk', 'Traditional', 'Traditional religion', 'Animism', 'Animist', 'Ethnic religion'],
  Unaffiliated: ['None', 'No religion', 'Atheism', 'Atheist', 'Agnostic', 'Non-religious', 'Irreligious', 'Secular'],
};

/** Canonical religion for the player's input (exact, else fuzzy on table entries of 6+ chars), or null. */
export function mapReligion(input) {
  const q = normalise(input);
  if (q === '') return null;
  const entries = [];
  for (const [canon, names] of Object.entries(RELIGIONS)) {
    for (const n of [canon, ...names]) entries.push({ canon, key: normalise(n) });
  }
  const exact = entries.find((e) => e.key === q);
  if (exact) return exact.canon;
  let best = null;
  let bestDist = 2;
  for (const e of entries) {
    if (e.key.length < 6) continue;
    const d = levenshtein(q, e.key);
    if (d <= 1 && d < bestDist) {
      best = e.canon;
      bestDist = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function answerName(a) {
  return typeof a === 'string' ? a : a.name;
}

function formatNumber(n) {
  let s = String(n);
  if (/e/i.test(s)) s = n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 }); // no exponent
  const [int, dec] = s.split('.');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dec ? '.' + dec : '');
}

function formatMinutes(mins) {
  const total = Math.round(mins); // round first so 119.6 is "2h 0m", never "1h 60m"
  const h = Math.floor(total / 60);
  const m = total - h * 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function expectedNumber(category, value) {
  if (category.id === 'flightTime') return formatMinutes(value);
  const unit = category.unit ? ' ' + category.unit : '';
  return formatNumber(value) + unit;
}

// ---------------------------------------------------------------------------
// checkAnswer
// ---------------------------------------------------------------------------

const result = (status, expected, parsed) =>
  parsed === undefined ? { status, expected } : { status, expected, parsed };

function checkNumber(category, value, input) {
  const expected = expectedNumber(category, value);
  const text = Array.isArray(input) ? input[0] : input;
  const guess = parseNumber(text, category.id);
  if (guess === null) return result('invalid', expected);
  let allowed;
  if (category.type === 'number-pct') {
    allowed = Math.max(category.tolerance * Math.abs(value), category.absFloor ?? 0);
  } else {
    allowed = category.tolerance;
  }
  // tiny slack so floating-point noise never turns an inclusive boundary into a miss
  const slack = 1e-9 * Math.max(1, Math.abs(value));
  let ok = Math.abs(guess - value) <= allowed + slack;
  // maleHeight (SCHEMA 4.1, 1.8): the reveal shows the value rounded to a whole inch, so a guess within the
  // tolerance of that shown value is right too. The shown answer and the check then always agree.
  if (!ok && category.id === 'maleHeight') ok = Math.abs(guess - Math.round(value)) <= allowed + slack;
  return result(ok ? 'correct' : 'wrong', expected, guess);
}

// At least min(n, length) distinct list entries must be matched, and every piece given must match
// some entry. Fuzzy and exact candidates both take part in the one-piece-per-entry matching.
function checkSet(category, answers, input, matchOpts, expected, toParsed) {
  // Splitting on "and" would cut names like "Trinidad and Tobago": re-join adjacent pieces
  // when "<a> and <b>" matches an answer.
  const split = splitPieces(input);
  const joined = [];
  for (let i = 0; i < split.length; i++) {
    if (i + 1 < split.length && matchingIndices(`${split[i]} and ${split[i + 1]}`, answers, matchOpts).length > 0) {
      joined.push(`${split[i]} and ${split[i + 1]}`);
      i++;
    } else {
      joined.push(split[i]);
    }
  }
  const seen = new Set();
  const pieces = [];
  for (const p of joined) {
    const key = normalise(p);
    if (key !== '' && !seen.has(key)) {
      seen.add(key);
      pieces.push(p);
    }
  }
  if (pieces.length === 0) return result('invalid', expected);
  const required = Math.min(category.n, answers.length);
  const allowed = pieces.map((p) => matchingIndices(p, answers, matchOpts));
  const { size, owner } = maxMatching(allowed);
  const parsed = toParsed([...owner.keys()].sort((a, b) => a - b));
  // Every piece must resolve to some list entry. Two pieces that resolve to the same entry
  // ("USA", "United States") count once because the matching gives each entry to one piece only.
  const ok = size >= required && allowed.every((a) => a.length > 0);
  return result(ok ? 'correct' : 'wrong', expected, parsed);
}

/**
 * flagColours (SCHEMA 4.11, 1.8). input: the n rows, each a string (the text of the colour box) or null (the row's
 * "No colour" box is ticked). k = min(n, number of colours on the flag).
 *  - invalid (asked again, no turn used): a row that is neither ticked nor has a letter in it, a row with a word that is no
 *    colour, a missing row, or every row ticked;
 *  - correct: exactly k rows are filled, they hold k different colours, all of them on the flag (so the other n - k rows
 *    are ticked); anything else is wrong (a tick on a flag with n or more colours, a surplus colour, a colour not on the
 *    flag, the same colour twice).
 */
export function checkColourRows(category, value, input) {
  const expected = value.join(', ');
  const n = category.n;
  const rows = Array.isArray(input) ? input : [];
  if (rows.length !== n) return result('invalid', expected);
  let filled = 0;
  const colours = [];
  for (const row of rows) {
    if (row === null) continue;
    if (typeof row !== 'string' || !/\p{L}/u.test(row)) return result('invalid', expected); // blank row
    const parsed = parseColours(row);
    if (parsed === null) return result('invalid', expected); // unknown word, or only modifier / filler words
    filled++;
    colours.push(...parsed);
  }
  if (filled === 0) return result('invalid', expected); // every row ticked
  const distinct = [...new Set(colours)];
  const k = Math.min(n, value.length);
  const ok = filled === k && colours.length === k && distinct.length === k && distinct.every((c) => value.includes(c));
  return result(ok ? 'correct' : 'wrong', expected, distinct);
}

// Categories whose text answers also accept a simple English plural ("beers", "wines", "lions", "dollars"). Not names of people,
// places or codes (famousPeople, capital, nativeName, domain, religion).
const PLURAL_CATEGORIES = new Set(['landmarks', 'nationalAnimal', 'currency', 'mainExport', 'dish', 'alcohol', 'nationalSport']);

export function checkAnswer(category, value, input, ctx = {}) {
  if (value === null || value === undefined) {
    throw new Error(`No data for category ${category.id}: the game must re-spin (SCHEMA 2.2)`);
  }
  switch (category.type) {
    case 'number-pct':
    case 'number-abs':
      return checkNumber(category, value, input);

    case 'text-one': {
      const text = Array.isArray(input) ? input[0] : input;
      if (category.id === 'religion') {
        const stored = value[0];
        const mapped = mapReligion(text);
        if (normalise(text) === '') return result('invalid', stored);
        return result(mapped === stored ? 'correct' : 'wrong', stored, mapped);
      }
      // alcohol (SCHEMA 1.9): the value is ONE Answer (the #1 drink), not a list; only its name and aliases are accepted
      let answers = Array.isArray(value) ? value : [value];
      const expected = answers.map(answerName).join(', ');
      if (normalise(text) === '') return result('invalid', expected);
      // landmarks (SCHEMA 1.8): any famous landmark counts, so the extra accepted ones (landmarksMore) are matched too
      if (category.id === 'landmarks') {
        const more = ctx.countries && ctx.iso3 && ctx.countries[ctx.iso3] ? ctx.countries[ctx.iso3].landmarksMore : null;
        if (Array.isArray(more) && more.length) answers = [...answers, ...more];
      }
      const idx = matchAnswer(text, answers, {
        fuzzy: category.id !== 'domain',
        surname: category.id === 'famousPeople',
        plural: PLURAL_CATEGORIES.has(category.id),
      });
      return result(idx >= 0 ? 'correct' : 'wrong', expected, idx >= 0 ? answerName(answers[idx]) : undefined);
    }

    case 'text-all': {
      const expected = value.map(answerName).join(', ');
      return checkSet(category, value, input, {}, expected, (idxs) => idxs.map((i) => answerName(value[i])));
    }

    case 'text-any-n': {
      // neighbours: value is iso3[]; match against each country's name and aliases
      const countries = ctx.countries || {};
      const answers = value.map((iso3) => {
        const c = countries[iso3];
        if (!c) throw new Error(`neighbours: ${iso3} is missing from ctx.countries`);
        return { name: c.name, aliases: c.aliases || [] };
      });
      const expected = answers.map((a) => a.name).join(', ');
      return checkSet(category, answers, input, { guard: countryNameGuard(countries) }, expected, (idxs) => idxs.map((i) => value[i]));
    }

    case 'colours':
      return checkColourRows(category, value, input);

    case 'outline': {
      const country = (ctx.countries || {})[ctx.iso3];
      if (!country) throw new Error('outline check needs ctx.countries and ctx.iso3');
      const text = Array.isArray(input) ? input[0] : input;
      if (normalise(text) === '') return result('invalid', country.name);
      const idx = matchAnswer(text, [{ name: country.name, aliases: country.aliases || [] }], {
        guard: countryNameGuard(ctx.countries),
      });
      return result(idx >= 0 ? 'correct' : 'wrong', country.name);
    }

    default:
      throw new Error('Unknown category type: ' + category.type);
  }
}
