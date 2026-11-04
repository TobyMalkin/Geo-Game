// "Report wrong answer" logic (SCHEMA 4.28): the report payload, sending it to a Google Form, reading the published sheet
// (CSV) back, and the review page's grouping and marks. Pure ES module: no DOM, imports nothing, runs in Node.
//
//   isConfigured(cfg)                     -> boolean
//   buildPayload(input)                   -> { ok: true, values } | { ok: false, error }    (whitelist, trim, limits)
//   encodeBody(cfg, values)               -> URL-encoded form body (only the fields the config names)
//   sendReport(cfg, values, fetchFn)      -> Promise<boolean>   true = the request went out, false = it could not be sent
//   parseCsv(text)                        -> string[][]
//   reportsFromCsv(rows)                  -> report[]   newest first
//   groupReports(reports)                 -> group[]    same country + category + reported answer
//   createStore(storage)                  -> { get, set, status, all }   private marks and notes (localStorage)
//   acceptedJson(groups, store)           -> [{ iso3, category, stored, reported, note }]

export const REPORT_VERSION = 'schema 1.18';
export const FIELD_KEYS = ['iso3', 'country', 'category', 'stored', 'reported', 'comment', 'given', 'mode', 'version'];
export const LIMITS = { reported: 200, comment: 500, stored: 1000, given: 300, country: 100, category: 40, mode: 10, version: 40 };
export const STATUSES = ['new', 'accepted', 'rejected', 'unsure'];
export const STORE_KEY = 'geogame.review.v1';

export function isConfigured(cfg) {
  return !!cfg && typeof cfg.formAction === 'string' && /^https?:\/\//.test(cfg.formAction)
    && !!cfg.fields && typeof cfg.fields.reported === 'string' && cfg.fields.reported !== '';
}

export function isSheetConfigured(cfg) {
  return !!cfg && typeof cfg.sheetCsv === 'string' && /^https?:\/\//.test(cfg.sheetCsv);
}

/** Text with control characters removed and the ends trimmed; non-strings become ''. */
function clean(v, max, keepNewlines = false) {
  if (typeof v !== 'string') return '';
  const re = keepNewlines ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g;
  return v.replace(/\r\n?/g, '\n').replace(re, keepNewlines ? '' : ' ').trim().slice(0, max);
}

/**
 * The values sent for one report. Only the named keys are read, so nothing else (a player name, say) can leak in. The
 * player's suggestion and comment are checked against their limits (not cut); the other fields are cut to size.
 */
export function buildPayload(input = {}) {
  const reported = clean(input.reported, 10000);
  if (reported === '') return { ok: false, error: 'Please type what the answer should be.', field: 'reported' };
  if (reported.length > LIMITS.reported) return { ok: false, error: `Please keep it to ${LIMITS.reported} characters or fewer.`, field: 'reported' };
  const comment = clean(input.comment, 10000, true);
  if (comment.length > LIMITS.comment) return { ok: false, error: `Please keep the comment to ${LIMITS.comment} characters or fewer.`, field: 'comment' };
  const iso3 = clean(input.iso3, 10).toUpperCase();
  if (!/^[A-Z]{3}$/.test(iso3)) return { ok: false, error: 'This question cannot be reported.', field: 'reported' };
  const mode = input.mode === 'display' ? 'display' : 'type';
  return {
    ok: true,
    values: {
      iso3,
      country: clean(input.country, LIMITS.country),
      category: clean(input.category, LIMITS.category),
      stored: clean(input.stored, LIMITS.stored),
      reported,
      comment,
      given: clean(input.given, LIMITS.given),
      mode,
      version: clean(input.version === undefined ? REPORT_VERSION : input.version, LIMITS.version),
    },
  };
}

export function encodeBody(cfg, values) {
  const body = new URLSearchParams();
  for (const k of FIELD_KEYS) {
    const id = cfg.fields && cfg.fields[k];
    if (typeof id === 'string' && id !== '' && typeof values[k] === 'string') body.append(id, values[k]);
  }
  return body.toString();
}

/**
 * POSTs the report to the Google Form. The request is no-cors, so the answer is opaque: a request that went out counts as
 * sent; a rejected one (offline, blocked) counts as not sent.
 */
export async function sendReport(cfg, values, fetchFn = (typeof fetch === 'function' ? fetch : null)) {
  if (!isConfigured(cfg) || !fetchFn) return false;
  try {
    await fetchFn(cfg.formAction, {
      method: 'POST',
      mode: 'no-cors',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encodeBody(cfg, values),
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Review page
// ---------------------------------------------------------------------------

/** CSV (RFC 4180 style): quoted fields, commas and line breaks inside quotes, "" for a quote, CRLF or LF; blank lines skipped. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let started = false; // the current row has any content, so a trailing newline does not add an empty row
  const s = String(text).replace(/^﻿/, '');
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => {
    endField();
    if (started && !(row.length === 1 && row[0] === '')) rows.push(row);
    row = []; started = false;
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; started = true; }
    else if (ch === ',') { endField(); started = true; }
    else if (ch === '\n') endRow();
    else if (ch === '\r') { if (s[i + 1] === '\n') i++; endRow(); }
    else { field += ch; started = true; }
  }
  if (started || field !== '' || row.length) endRow();
  return rows;
}

/**
 * Report objects from the parsed sheet. Columns are found by header name (case-insensitive); a column whose name is not
 * recognised (a typo such as "Cateogry", or a rename) falls back to its place in the brief order: Timestamp first, then ISO3,
 * Country, Category, Stored, Reported, Comment, Given, Mode, Version. Newest first.
 */
export function reportsFromCsv(rows) {
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const order = ['timestamp', ...FIELD_KEYS];
  const col = Object.fromEntries(order.map((k) => [k, head.indexOf(k)]));
  const claimed = new Set(Object.values(col).filter((i) => i >= 0));
  order.forEach((k, place) => {
    if (col[k] === -1 && place < head.length && !claimed.has(place)) { col[k] = place; claimed.add(place); }
  });
  if (col.reported === -1 || col.iso3 === -1) throw new Error('The sheet needs at least the columns Timestamp, ISO3, Country, Category, Stored and Reported, in that order.');
  const reports = [];
  rows.slice(1).forEach((r, n) => {
    const get = (k) => (col[k] >= 0 && r[col[k]] !== undefined ? r[col[k]].trim() : '');
    const rep = { row: n + 1 };
    for (const k of order) rep[k] = get(k);
    rep.iso3 = rep.iso3.toUpperCase();
    if (rep.iso3 === '' && rep.reported === '') return; // an empty row
    rep.key = reportKey(rep);
    reports.push(rep);
  });
  return reports.reverse(); // the sheet is in the order the reports came in
}

export function reportKey(rep) {
  return `${rep.timestamp}|${rep.iso3}|${rep.category}|${rep.reported}`;
}

const norm = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
export { norm as normaliseText };

/** Reports about the same country, category and suggested answer, newest group first; each keeps its reports newest first. */
export function groupReports(reports) {
  const groups = new Map();
  for (const rep of reports) {
    const id = `${rep.iso3}|${rep.category}|${norm(rep.reported)}`;
    if (!groups.has(id)) groups.set(id, { id, iso3: rep.iso3, category: rep.category, reported: rep.reported, items: [] });
    groups.get(id).items.push(rep);
  }
  return [...groups.values()].map((g) => ({ ...g, count: g.items.length, latest: g.items[0] }));
}

/** Marks and private notes, kept per report key. `storage` is localStorage (or any object with getItem/setItem). */
export function createStore(storage, storeKey = STORE_KEY) {
  let data = {};
  try {
    const raw = storage && storage.getItem(storeKey);
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch { data = {}; }
  const persist = () => { try { storage.setItem(storeKey, JSON.stringify(data)); } catch { /* storage full or blocked: marks last until the page closes */ } };
  const entry = (key) => {
    const e = data[key];
    return e && typeof e === 'object' ? { status: STATUSES.includes(e.status) ? e.status : 'new', note: typeof e.note === 'string' ? e.note : '' } : { status: 'new', note: '' };
  };
  return {
    get: entry,
    set(key, patch) {
      const next = { ...entry(key), ...patch };
      if (!STATUSES.includes(next.status)) next.status = 'new';
      if (next.status === 'new' && next.note === '') delete data[key]; else data[key] = next;
      persist();
    },
    all: () => ({ ...data }),
  };
}

/** A group's mark is the mark of its newest marked report. Setting it marks every report in the group. */
export function groupMark(group, store) {
  for (const rep of group.items) {
    const e = store.get(rep.key);
    if (e.status !== 'new' || e.note !== '') return e;
  }
  return { status: 'new', note: '' };
}

export function setGroupMark(group, store, patch) {
  for (const rep of group.items) store.set(rep.key, patch);
}

/** The accepted groups as the Lead wants them: one entry per group. */
export function acceptedJson(groups, store) {
  return groups
    .filter((g) => groupMark(g, store).status === 'accepted')
    .map((g) => ({
      iso3: g.iso3,
      category: g.category,
      stored: g.latest.stored,
      reported: g.reported,
      note: groupMark(g, store).note,
    }));
}
