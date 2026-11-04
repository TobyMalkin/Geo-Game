// Answer timer (SCHEMA 4.27, CR-16): 60 seconds per question. Pure timing logic with an injectable clock, so tests can
// fake time. No DOM here: main.js renders the snapshots and decides what expiry means in each answer mode.
//
// Time is measured from timestamps (startedAt and the clock now), never by counting ticks, so a background tab whose
// timers are throttled still ends on time: the next tick (or a visibilitychange check) sees the real elapsed time.

import { checkAnswer } from './answer.js';

export const TIMER_SECONDS = 60;
export const TIMER_MS = TIMER_SECONDS * 1000;
export const URGENT_SECONDS = 10;     // the last 10 seconds change colour
export const MILESTONES = [30, 10, 0]; // the only seconds-left values announced to screen readers
export const POLL_MS = 200;

/** Whole seconds left, rounded up (60 at the start, 0 only when the time is used up), clamped to 0..total. */
export function secondsLeft(remainingMs, total = TIMER_MS) {
  const r = Math.min(Math.max(remainingMs, 0), total);
  return Math.ceil(r / 1000);
}

/** "1:00", "0:59", "0:05", "0:00". */
export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** True for the last 10 seconds (including the moment the time is up). */
export function isUrgent(seconds) {
  return seconds <= URGENT_SECONDS;
}

/** What a screen reader hears at a milestone: "30 s left", "10 s left", "Time's up". */
export function milestoneMessage(m) {
  return m === 0 ? "Time's up" : `${m} s left`;
}

/** The state of a timer started at startedAt, seen at time nowMs. */
export function snapshotAt(startedAt, nowMs, total = TIMER_MS) {
  const remainingMs = Math.min(Math.max(total - (nowMs - startedAt), 0), total);
  const seconds = secondsLeft(remainingMs, total);
  return {
    remainingMs,
    seconds,
    fraction: remainingMs / total,
    text: formatClock(seconds),
    urgent: isUrgent(seconds),
    expired: remainingMs <= 0,
  };
}

/**
 * A one-question stopwatch counting down.
 *   now          () => ms, the clock (default Date.now); tests pass a fake one
 *   durationMs   length of the countdown (default 60 000)
 *   onTick(snap, milestone)   after start() and on every poll; milestone is 30, 10 or 0 the first time that many seconds
 *                (or fewer) are left, otherwise null. A throttled tab that jumps past several reports only the lowest.
 *   onExpire(snap)            once, when the time is used up; the timer has stopped by then
 *   setIntervalFn / clearIntervalFn   the scheduler (default the global one); tests pass fakes and call check() themselves
 * start() restarts from the full time. stop() cancels everything and never calls onExpire. check() recomputes from the
 * clock: it is what the poll calls, and what a visibilitychange handler should call.
 */
export function createTimer({
  now = () => Date.now(), durationMs = TIMER_MS, onTick = () => {}, onExpire = () => {},
  setIntervalFn = (...a) => globalThis.setInterval(...a), clearIntervalFn = (...a) => globalThis.clearInterval(...a), pollMs = POLL_MS,
} = {}) {
  let startedAt = 0;
  let handle = null;
  let running = false;
  let announced = new Set();

  function cancel() {
    if (handle !== null) clearIntervalFn(handle);
    handle = null;
    running = false;
  }

  function snapshot() {
    return snapshotAt(startedAt, now(), durationMs);
  }

  function check() {
    if (!running) return null;
    const snap = snapshot();
    let milestone = null;
    for (const m of MILESTONES) {
      if (snap.seconds <= m && !announced.has(m)) { announced.add(m); milestone = m; }
    }
    if (snap.expired) cancel();
    onTick(snap, milestone);
    if (snap.expired) onExpire(snap);
    return snap;
  }

  function start() {
    cancel();
    startedAt = now();
    announced = new Set();
    running = true;
    handle = setIntervalFn(check, pollMs);
    const snap = snapshot();
    onTick(snap, null);
    return snap;
  }

  function stop() {
    cancel();
  }

  return { start, stop, check, snapshot, get running() { return running; } };
}

/**
 * Type mode, time is up (SCHEMA 4.27): the answer is submitted as it stands.
 *   category, value   the question's category and the country's stored value
 *   typed             the text of every answer box, in order ('' for an empty box)
 *   noColour          flagColours only: per row, true when "No colour" is ticked
 *   ctx               { countries, iso3 } as for checkAnswer
 * Whatever text is there is checked normally; no text at all, or an answer checkAnswer cannot read (it says 'invalid'),
 * counts as wrong, and a blank box or a blank colour row is just left empty. Never throws.
 * Returns { correct: boolean, given: string[] } where given is the non-empty text that was checked.
 */
export function timeUpAnswer(category, value, typed, noColour = [], ctx = {}) {
  let input;
  let given;
  if (category.type === 'colours') {
    // a row that is ticked "No colour", or has no letters, is a null row, as in the normal path
    input = typed.map((v, n) => (noColour[n] || !/\p{L}/u.test(v) ? null : v));
    given = input.filter((v) => v !== null).map((v) => v.trim());
  } else {
    input = typed.length === 1 ? typed[0] : typed.slice();
    given = typed.map((v) => v.trim()).filter(Boolean);
  }
  if (given.length === 0) return { correct: false, given: [] };
  try {
    return { correct: checkAnswer(category, value, input, ctx).status === 'correct', given };
  } catch {
    return { correct: false, given };
  }
}
