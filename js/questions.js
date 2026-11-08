// Builds a playable question from (category, country) and formats the expected answer for display.
// Pure ES module: no DOM, no dependencies, importable in Node.
//
//   buildQuestion(category, iso3, countries) -> {
//     categoryId, iso3, type, label,
//     prompt,          // category prompt with {country} filled in (outline: no country name at all)
//     showCountry,     // false for outline: the UI must not display the country name before the answer
//     countryName,     // the answer country's name (the UI shows it only when showCountry is true)
//     inputs,          // [{ id, label, inputMode, placeholder }] one entry per answer box
//     hint,            // short help text, or ''
//     outlineUrl,      // outline only: path of the outline JSON, otherwise null
//     value,           // stored value for this category (never null)
//   }
//   formatExpected(category, value, { countries, iso3 }) -> string   (lists every stored item, never "and N more")
//   formatHeight(inches) -> string        5'9" style, rounded to the nearest inch
//   imageItems(category, value) -> [{ name, image }] | null   famousPeople / dish / landmarks reveal list (image: path or null)
//   alsoAccepted(category, country) -> string[]   landmarks only: the names of landmarksMore (accepted, shown as text, no photos)
//   militaryNeighbours(countries, rank) -> [{ rank, iso3, iso2, name }]   rank-1, rank, rank+1 that exist
//   formatRange(category, value) -> string | ''   Display mode: "Accepted range: 1,350 - 1,650 km²" (CR-20; numeric categories with a tolerance)

import { acceptedRange } from './answer.js';

/** Categories whose reveal lists every stored name with a picture; the value is the per-item data field. */
const IMAGE_FIELD = { famousPeople: 'portrait', dish: 'photo', landmarks: 'photo', alcohol: 'photo' };

const SUFFIX_CATEGORIES = new Set(['population', 'gdpPerCapita', 'area']);

function answerName(a) {
  return typeof a === 'string' ? a : a.name;
}

/** Display form of an answer: nativeName entries in a non-Latin script carry "latin" ("日本 (Nihon)"). */
function answerDisplay(a) {
  return a && typeof a === 'object' && typeof a.latin === 'string' && a.latin !== '' ? `${a.name} (${a.latin})` : answerName(a);
}

/** Number of answer boxes: the number of items the player must give, or 1. flagColours always has n rows (1.8). */
export function inputCount(category, value) {
  if (category.type === 'colours') return category.n;
  if (category.type === 'text-all' || category.type === 'text-any-n') {
    return Math.max(1, Math.min(category.n, Array.isArray(value) ? value.length : category.n));
  }
  return 1;
}

const ITEM_NAMES = {
  languages: 'Language',
  neighbours: 'Country',
  flagColours: 'Colour',
};

function numericInputMode(category) {
  if (category.id === 'militaryRank') return 'numeric';
  // highestPoint takes a "k" (1.2k, CR-18), which a phone's number pad cannot type, so it uses the full keyboard like the other suffix categories
  if (category.id === 'lifeExpectancy' || category.id === 'homicideRate') return 'decimal';
  return 'text'; // k / m / bn suffixes, feet and inches and h:mm need a full keyboard
}

function hintFor(category) {
  switch (category.id) {
    case 'population':
    case 'gdpPerCapita':
    case 'area':
      return 'Type a number. You can use k, m or bn, for example 67m, 1.4bn or 45,000.';
    case 'lifeExpectancy':
    case 'homicideRate':
      return 'Type a plain number, for example 72.5.';
    case 'maleHeight':
      return 'Type inches (70) or feet and inches (5\'10").';
    case 'flightTime':
      return 'Type minutes (150) or hours and minutes (2:30 or 2h 30m).';
    case 'militaryRank':
      return 'Type a whole number from 1 to 197.';
    case 'highestPoint':
      return 'Type the height in metres, for example 1234 or 1.2k.';
    case 'nationalSport':
      return 'Some countries have two national sports. Naming either one is correct.';
    case 'languages':
      return 'One language per box.';
    case 'neighbours':
      return 'One country per box.';
    case 'flagColours':
      return 'One colour per row, for example red or dark blue. Tick "No colour" for a row you do not need.';
    case 'religion':
      return 'Christianity, Islam, Hinduism, Buddhism, Judaism, Shinto, Folk religion or Unaffiliated.';
    case 'domain':
      return 'Type the country-code domain. The dot is optional.';
    case 'alcohol':
      return 'Name the one most popular alcoholic drink. Only the top drink counts.';
    case 'outline':
      return "Type the country's name.";
    default:
      return '';
  }
}

/**
 * Display mode (SCHEMA 4.24): the hint under the question. Typing hints (number formats, "one per box", tick boxes) go because
 * there is nothing to type; the category rule hints stay because the players judge their spoken answer by them.
 */
export function displayHint(category) {
  switch (category.id) {
    case 'nationalSport':
    case 'alcohol':
    case 'religion':
      return hintFor(category);
    default:
      return '';
  }
}

/**
 * Display mode: the question prompt without wording about how to type or tick an answer; tolerances and units stay.
 * Only two stored prompts have such wording (audited over all 25): flagColours (the "No colour" ticks) and
 * flightTime ("; enter minutes or h:mm").
 */
export function displayPrompt(category, prompt) {
  if (category.type === 'colours') return prompt.replace(/\s*Tick "No colour"[^.]*\./, '');
  if (category.id === 'flightTime') return prompt.replace(/;\s*enter[^)]*\)/, ')');
  return prompt;
}

/**
 * Category label to show with a question. The stored label ("Languages") does not name a number; for the defensive one-box case it is
 * reworded to match the number of answer boxes actually shown (1 box: "Main language").
 */
export function questionLabel(category, value) {
  if (category.id === 'languages' && inputCount(category, value) === 1) return 'Main language';
  return category.label; // flagColours is always "Flag colours": the count of colours must not leak (1.8)
}

export function buildQuestion(category, iso3, countries) {
  const country = countries && countries[iso3];
  if (!country) throw new Error(`buildQuestion: unknown country ${iso3}`);
  const value = country[category.id];
  if (value === null || value === undefined) {
    throw new Error(`buildQuestion: ${iso3} has no data for ${category.id} (the game must re-spin)`);
  }
  const isOutline = category.type === 'outline';
  const count = inputCount(category, value);
  const inputs = [];
  for (let i = 0; i < count; i++) {
    let label;
    if (count > 1 && ITEM_NAMES[category.id]) label = `${ITEM_NAMES[category.id]} ${i + 1}`;
    else label = count > 1 ? `Answer ${i + 1}` : 'Your answer';
    const numeric = category.type === 'number-pct' || category.type === 'number-abs';
    const input = {
      id: `answer-${i}`,
      label,
      inputMode: numeric ? numericInputMode(category) : 'text',
      placeholder: '',
    };
    // flagColours: every row has a "No colour" box at its end (accessible name "Row 2: no colour")
    if (category.type === 'colours') input.noColour = { id: `none-${i}`, label: 'No colour', ariaLabel: `Row ${i + 1}: no colour` };
    inputs.push(input);
  }
  let template = category.prompt;
  // The stored language prompt talks about 2 languages; it is worded to match the boxes actually shown.
  // SCHEMA 1.7: languages always has exactly 2 entries, so the stored prompt no longer needs its one-language
  // sentence. It is stripped here in case categories.json still carries it.
  if (category.id === 'languages') template = template.replace(/\s*\(If it has only one[^)]*\)/i, '');
  if (category.id === 'languages' && count === 1) template = 'Name the main language spoken in {country}.';
  const prompt = isOutline
    ? template.replace(/\{country\}/g, 'this country')
    : template.replace(/\{country\}/g, country.name);
  return {
    categoryId: category.id,
    iso3,
    type: category.type,
    label: questionLabel(category, value),
    prompt,
    showCountry: !isOutline,
    countryName: country.name,
    inputs,
    hint: hintFor(category),
    outlineUrl: isOutline ? value : null,
    value,
  };
}

// ---------------------------------------------------------------------------
// Expected-answer text
// ---------------------------------------------------------------------------

function group(n) {
  // integer part with thousands separators, decimals kept as they are
  const s = String(n);
  if (/e/i.test(s)) return n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
  const [int, dec] = s.split('.');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dec ? '.' + dec : '');
}

function formatMinutes(mins) {
  const total = Math.round(mins);
  const h = Math.floor(total / 60);
  const m = total - h * 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Inches as feet and inches, rounded to the nearest inch: 69.4 -> 5'9". */
export function formatHeight(inches) {
  const total = Math.round(inches);
  const ft = Math.floor(total / 12);
  return `${ft}'${total - ft * 12}"`;
}

/** Metres as feet, rounded to the nearest foot: 4806 -> 15768. */
export function metresToFeet(m) {
  return Math.round(m * 3.28084);
}

function formatNumberValue(category, value, ctx = {}) {
  if (category.id === 'highestPoint') {
    // "Mont Blanc, 4,806 m (15,768 ft)": the peak name (country.highestPointName) when the data has one
    const country = (ctx.countries || {})[ctx.iso3];
    const name = country && typeof country.highestPointName === 'string' ? country.highestPointName.trim() : '';
    const height = `${group(value)} m (${group(metresToFeet(value))} ft)`;
    return name ? `${name}, ${height}` : height;
  }
  if (category.id === 'maleHeight') return `${formatHeight(value)} (${Math.round(value * 2.54)} cm)`;
  if (category.id === 'flightTime') return formatMinutes(value);
  if (category.id === 'militaryRank') return `place ${group(value)}`;
  if (category.id === 'gdpPerCapita') return `$${group(value)}`;
  const unit = category.unit ? ' ' + category.unit : '';
  return group(value) + unit;
}

/**
 * Display mode reveal (CR-20, SCHEMA 4.24): "Accepted range: <low> - <high>" for the categories with a numeric
 * tolerance, formatted like the shown answer (the unit once, at the end; $ before each gdpPerCapita figure; feet and inches for
 * maleHeight; hours and minutes for flightTime). The bounds come from acceptedRange in answer.js, the same maths as the check.
 * '' for every other category, militaryRank included (it shows its neighbours instead).
 */
export function formatRange(category, value) {
  const r = acceptedRange(category, value);
  if (!r) return '';
  const one = { gdpPerCapita: (n) => `$${group(n)}`, maleHeight: formatHeight, flightTime: formatMinutes }[category.id] || group;
  const tail = !['gdpPerCapita', 'maleHeight', 'flightTime'].includes(category.id) && category.unit ? ' ' + category.unit : '';
  return `Accepted range: ${[r.low, r.high].map(one).join(' - ')}${tail}`;
}

/** "A", "A and B", "A, B and C" (for names in running text). */
export function listAnd(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The notice for chosen categories that were left out because no country in the game's regions has data for them (CR-15):
 * "Highest point has no data for these countries and was left out." Empty string for an empty list.
 */
export function droppedNotice(labels) {
  if (!labels || labels.length === 0) return '';
  return `${listAnd(labels)} ${labels.length === 1 ? 'has' : 'have'} no data for these countries and ${labels.length === 1 ? 'was' : 'were'} left out.`;
}

/**
 * Index of the first blank answer box, or -1 when every box is filled. A box is blank when it is empty,
 * whitespace only, or has no letter or digit at all (for example "-", "?" or "...").
 */
export function firstBlank(values) {
  return values.findIndex((v) => typeof v !== 'string' || !/[\p{L}\p{N}]/u.test(v));
}

/**
 * Text shown when the correct answer is revealed.
 * ctx: { countries, iso3 }. countries is needed for neighbours (names of the listed countries) and
 * outline (needs iso3). Every list shows all its stored items (CR-4: the old 5-example cap is gone).
 */
export function formatExpected(category, value, ctx = {}) {
  if (value === null || value === undefined) return '';
  switch (category.type) {
    case 'number-pct':
    case 'number-abs':
      return formatNumberValue(category, value, ctx);

    case 'text-one': {
      if (category.id === 'religion') return String(value[0]);
      // alcohol (1.9) stores ONE Answer object, not a list
      const names = (Array.isArray(value) ? value : [value]).map(category.id === 'nativeName' ? answerDisplay : answerName);
      // every stored name (for famousPeople and dish the UI also shows a picture next to each)
      const text = names.join(', ');
      return names.length > 1 ? `${text} (any one is correct)` : text;
    }

    case 'text-all': {
      return value.map(answerName).join(', ');
    }

    case 'text-any-n': {
      const countries = ctx.countries || {};
      const names = value.map((iso3) => (countries[iso3] ? countries[iso3].name : iso3));
      const text = names.join(', ');
      return names.length > category.n ? `${text} (any ${category.n} are correct)` : text;
    }

    case 'colours': {
      const text = value.join(', '); // every colour of the flag, never capped (SCHEMA 4.11, 1.8)
      return value.length > category.n ? `${text} (any ${category.n} are correct)` : text;
    }

    case 'outline': {
      const country = (ctx.countries || {})[ctx.iso3];
      return country ? country.name : '';
    }

    default:
      return String(value);
  }
}

/**
 * Reveal list for categories shown with a picture next to each name: [{ name, image }], image being the
 * relative path stored in the data ("portrait" for famousPeople, "photo" for dish) or null. Other categories: null.
 */
export function imageItems(category, value) {
  const field = IMAGE_FIELD[category.id];
  if (!field || value === null || value === undefined) return null;
  if (!Array.isArray(value) && category.id !== 'alcohol') return null; // alcohol (1.9): one Answer object, shown as a one-item list
  return (Array.isArray(value) ? value : [value]).map((a) => ({
    name: answerName(a),
    image: a && typeof a === 'object' && typeof a[field] === 'string' && a[field] !== '' ? a[field] : null,
  }));
}

/** Landmarks only: names of the extra accepted landmarks (country.landmarksMore), shown after the main list as text. Else []. */
export function alsoAccepted(category, country) {
  if (!category || category.id !== 'landmarks' || !country || !Array.isArray(country.landmarksMore)) return [];
  return country.landmarksMore.map(answerName);
}

/**
 * Countries ranked one above, at and one below `rank` (militaryRank is 1..197, each used once), best first.
 * Only ranks that exist are returned (rank 1 has nobody above, 197 nobody below). Uses the whole country set.
 */
export function militaryNeighbours(countries, rank) {
  const byRank = new Map();
  for (const c of Object.values(countries || {})) {
    if (Number.isInteger(c.militaryRank)) byRank.set(c.militaryRank, c);
  }
  const out = [];
  for (const r of [rank - 1, rank, rank + 1]) {
    const c = byRank.get(r);
    if (c) out.push({ rank: r, iso3: c.iso3, iso2: c.iso2, name: c.name });
  }
  return out;
}

/**
 * CR-12 (SCHEMA 1.15): the neutral status note of a country, "UN observer state" (PSE, VAT) or "Not a UN member state" (TWN, XKX);
 * an empty string for the other 193 (no `status` field).
 */
export function statusNote(country) {
  return country && typeof country.status === 'string' ? country.status : '';
}

/** True when the category accepts k / m / bn suffixes (used by tests and hints). */
export function acceptsSuffix(categoryId) {
  return SUFFIX_CATEGORIES.has(categoryId);
}
