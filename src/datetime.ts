/**
 * The whitelisted `datetime` module: date, datetime, timedelta.
 *
 * All values are naive (no tzinfo). The host-provided session timezone only
 * affects datetime.now() / date.today() and parsing of offset-bearing ISO
 * strings — everything else is pure calendar arithmetic, like CPython's
 * naive datetimes.
 */

import { AttributeError, OverflowError, TypeError, ValueError } from './errors';
import { PyFloat, isNum, toFloat } from './numbers';
import {
  Kwargs, NativeFn, PyBuiltin, PyDate, PyDateTime, PyModule, PyTimeDelta, PyType, PyValue,
  T_DATE, T_DATETIME, T_TIMEDELTA, typeName,
} from './values';

// ── Calendar helpers ─────────────────────────────────────────────────────────

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MS_PER_DAY = 86_400_000;

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1];
}

function validateDate(year: number, month: number, day: number): void {
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    throw new ValueError(`year must be in 1..9999, not ${year}`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new ValueError(`month must be in 1..12, not ${month}`);
  }
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) {
    throw new ValueError(`day ${day} must be in range 1..${daysInMonth(year, month)} for month ${month} in year ${year}`);
  }
}

function validateTime(hour: number, minute: number, second: number, microsecond: number): void {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new ValueError(`hour must be in 0..23, not ${hour}`);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new ValueError(`minute must be in 0..59, not ${minute}`);
  if (!Number.isInteger(second) || second < 0 || second > 59) throw new ValueError(`second must be in 0..59, not ${second}`);
  if (!Number.isInteger(microsecond) || microsecond < 0 || microsecond > 999999) {
    throw new ValueError(`microsecond must be in 0..999999, not ${microsecond}`);
  }
}

/** Epoch milliseconds via UTC Date math. setUTCFullYear handles years 1-99
 *  correctly where Date.UTC would map them to 19xx. */
function utcMillis(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, 0);
  return d.getTime();
}

interface Components {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number; microsecond: number;
}

/** Datetime → {integer epoch ms, leftover µs in [0, 1000)}. A single
 *  epoch-microseconds number would exceed 2^53 for the year-9999 range. */
function datetimeToMsUs(dt: PyDateTime): { ms: number; us: number } {
  const ms = utcMillis(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second) + Math.floor(dt.microsecond / 1000);
  return { ms, us: dt.microsecond % 1000 };
}

function msUsToComponents(ms: number, us: number): Components {
  const carry = Math.floor(us / 1000);
  ms += carry;
  us -= carry * 1000;
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    microsecond: d.getUTCMilliseconds() * 1000 + us,
  };
}

function timedeltaToMsUs(td: PyTimeDelta): { ms: number; us: number } {
  const ms = td.days * MS_PER_DAY + td.seconds * 1000 + Math.floor(td.microseconds / 1000);
  return { ms, us: td.microseconds % 1000 };
}

/** Normalize to CPython invariants: 0 <= seconds < 86400, 0 <= microseconds
 *  < 1e6, days carries the sign. */
function makeTimedelta(ms: number, us: number): PyTimeDelta {
  const carry = Math.floor(us / 1000);
  ms += carry;
  us -= carry * 1000;
  const days = Math.floor(ms / MS_PER_DAY);
  const remMs = ms - days * MS_PER_DAY;
  const seconds = Math.floor(remMs / 1000);
  const microseconds = (remMs - seconds * 1000) * 1000 + us;
  return new PyTimeDelta(days, seconds, microseconds);
}

/** Build a timedelta from a possibly fractional millisecond total, rounding
 *  to the nearest microsecond. */
function timedeltaFromFloatMs(totalMs: number): PyTimeDelta {
  const ms = Math.floor(totalMs);
  const us = Math.round((totalMs - ms) * 1000);
  return makeTimedelta(ms, us);
}

function weekdayOf(year: number, month: number, day: number): number {
  return (new Date(utcMillis(year, month, day)).getUTCDay() + 6) % 7;
}

function dayOfYear(year: number, month: number, day: number): number {
  let n = day;
  for (let m = 1; m < month; m++) n += daysInMonth(year, m);
  return n;
}

// ── repr / str ───────────────────────────────────────────────────────────────

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

export function isoformatDate(d: { year: number; month: number; day: number }): string {
  return `${pad(d.year, 4)}-${pad(d.month, 2)}-${pad(d.day, 2)}`;
}

export function isoformatDatetime(dt: PyDateTime, sep = 'T'): string {
  let time = `${pad(dt.hour, 2)}:${pad(dt.minute, 2)}:${pad(dt.second, 2)}`;
  if (dt.microsecond !== 0) time += `.${pad(dt.microsecond, 6)}`;
  return `${isoformatDate(dt)}${sep}${time}`;
}

export function datetimeRepr(value: PyDate | PyDateTime | PyTimeDelta): string {
  if (value instanceof PyDate) return `datetime.date(${value.year}, ${value.month}, ${value.day})`;
  if (value instanceof PyDateTime) {
    // CPython always shows hour and minute, appends second and microsecond
    // only when needed.
    const parts = [value.year, value.month, value.day, value.hour, value.minute];
    if (value.second || value.microsecond) parts.push(value.second);
    if (value.microsecond) parts.push(value.microsecond);
    return `datetime.datetime(${parts.join(', ')})`;
  }
  const parts: string[] = [];
  if (value.days) parts.push(`days=${value.days}`);
  if (value.seconds) parts.push(`seconds=${value.seconds}`);
  if (value.microseconds) parts.push(`microseconds=${value.microseconds}`);
  return parts.length ? `datetime.timedelta(${parts.join(', ')})` : 'datetime.timedelta(0)';
}

export function datetimeStr(value: PyDate | PyDateTime | PyTimeDelta): string {
  if (value instanceof PyDate) return isoformatDate(value);
  if (value instanceof PyDateTime) return isoformatDatetime(value, ' ');
  const hours = Math.floor(value.seconds / 3600);
  const minutes = Math.floor((value.seconds % 3600) / 60);
  const seconds = value.seconds % 60;
  let s = `${hours}:${pad(minutes, 2)}:${pad(seconds, 2)}`;
  if (value.microseconds) s += `.${pad(value.microseconds, 6)}`;
  if (value.days) s = `${value.days} day${Math.abs(value.days) !== 1 ? 's' : ''}, ${s}`;
  return s;
}

function fromComponents(c: Components): PyDateTime {
  return new PyDateTime(c.year, c.month, c.day, c.hour, c.minute, c.second, c.microsecond);
}

function componentsOf(value: PyDate | PyDateTime): Components {
  if (value instanceof PyDateTime) return value;
  return { year: value.year, month: value.month, day: value.day, hour: 0, minute: 0, second: 0, microsecond: 0 };
}

/** A date or datetime rendered through a format spec, which is a strftime
 *  pattern (`f"{d:%Y-%m}"`). */
export function formatDatetime(value: PyDate | PyDateTime, spec: string): string {
  return strftime(componentsOf(value), spec);
}

// ── strftime / strptime ──────────────────────────────────────────────────────

export function strftime(c: Components, fmt: string): string {
  let result = '';
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] !== '%' || i === fmt.length - 1) {
      result += fmt[i];
      continue;
    }
    const code = fmt[++i];
    switch (code) {
      case 'Y': result += pad(c.year, 4); break;
      case 'y': result += pad(c.year % 100, 2); break;
      case 'm': result += pad(c.month, 2); break;
      case 'd': result += pad(c.day, 2); break;
      case 'H': result += pad(c.hour, 2); break;
      case 'M': result += pad(c.minute, 2); break;
      case 'S': result += pad(c.second, 2); break;
      case 'f': result += pad(c.microsecond, 6); break;
      case 'I': result += pad(c.hour % 12 || 12, 2); break;
      case 'p': result += c.hour < 12 ? 'AM' : 'PM'; break;
      case 'j': result += pad(dayOfYear(c.year, c.month, c.day), 3); break;
      case 'a': result += WEEKDAY_NAMES[weekdayOf(c.year, c.month, c.day)].slice(0, 3); break;
      case 'A': result += WEEKDAY_NAMES[weekdayOf(c.year, c.month, c.day)]; break;
      case 'b': result += MONTH_NAMES[c.month - 1].slice(0, 3); break;
      case 'B': result += MONTH_NAMES[c.month - 1]; break;
      case '%': result += '%'; break;
      default: result += '%' + code;
    }
  }
  return result;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const STRPTIME_PATTERNS: Record<string, string> = {
  Y: '(\\d{1,4})', y: '(\\d{1,2})', m: '(\\d{1,2})', d: '(\\d{1,2})',
  H: '(\\d{1,2})', M: '(\\d{1,2})', S: '(\\d{1,2})', f: '(\\d{1,6})',
  I: '(\\d{1,2})', j: '(\\d{1,3})',
  p: '(AM|PM)',
  a: `(${WEEKDAY_NAMES.map(n => n.slice(0, 3)).join('|')})`,
  A: `(${WEEKDAY_NAMES.join('|')})`,
  b: `(${MONTH_NAMES.map(n => n.slice(0, 3)).join('|')})`,
  B: `(${MONTH_NAMES.join('|')})`,
};

function strptimeComponents(s: string, fmt: string): Components {
  let pattern = '';
  const fields: string[] = [];
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] === '%' && i < fmt.length - 1) {
      const code = fmt[++i];
      if (code === '%') {
        pattern += '%';
      } else if (Object.hasOwn(STRPTIME_PATTERNS, code)) {
        pattern += STRPTIME_PATTERNS[code];
        fields.push(code);
      } else {
        throw new ValueError(`'${code}' is a bad directive in format '${fmt}'`);
      }
    } else {
      pattern += escapeRegex(fmt[i]);
    }
  }
  const match = s.match(new RegExp(`^${pattern}$`, 'i'));
  if (!match) {
    throw new ValueError(`time data '${s}' does not match format '${fmt}'`);
  }

  const c: Components = { year: 1900, month: 1, day: 1, hour: 0, minute: 0, second: 0, microsecond: 0 };
  let pm: boolean | null = null;
  let hour12: number | null = null;
  let julian: number | null = null;
  let monthSet = false;
  for (let i = 0; i < fields.length; i++) {
    const value = match[i + 1];
    switch (fields[i]) {
      case 'Y': c.year = parseInt(value, 10); break;
      case 'y': { const y = parseInt(value, 10); c.year = y < 69 ? 2000 + y : 1900 + y; break; }
      case 'm': c.month = parseInt(value, 10); monthSet = true; break;
      case 'd': c.day = parseInt(value, 10); break;
      case 'H': c.hour = parseInt(value, 10); break;
      case 'M': c.minute = parseInt(value, 10); break;
      case 'S': c.second = parseInt(value, 10); break;
      case 'f': c.microsecond = parseInt(value.padEnd(6, '0'), 10); break;
      case 'I': hour12 = parseInt(value, 10); break;
      case 'p': pm = value.toUpperCase() === 'PM'; break;
      case 'j': julian = parseInt(value, 10); break;
      case 'b': case 'B': c.month = MONTH_NAMES.findIndex(n => n.toLowerCase().startsWith(value.toLowerCase())) + 1; monthSet = true; break;
      // %a / %A consume the weekday name but contribute nothing.
    }
  }
  if (hour12 !== null) {
    c.hour = pm ? (hour12 % 12) + 12 : hour12 % 12;
  }
  if (julian !== null && !monthSet) {
    let remaining = julian;
    let month = 1;
    while (remaining > daysInMonth(c.year, month)) {
      remaining -= daysInMonth(c.year, month);
      month++;
    }
    c.month = month;
    c.day = remaining;
  }
  validateDate(c.year, c.month, c.day);
  validateTime(c.hour, c.minute, c.second, c.microsecond);
  return c;
}

// ── ISO parsing ──────────────────────────────────────────────────────────────

const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?(Z|[+-]\d{2}:\d{2})?$/;

function parseIsoDatetime(s: string, toSessionTz: (ms: number) => Components): PyDateTime {
  const m = s.match(ISO_DATETIME);
  if (!m) throw new ValueError(`Invalid isoformat string: '${s}'`);
  const [, year, month, day, hour, minute, second, fraction, offset] = m;
  const c: Components = {
    year: parseInt(year, 10),
    month: parseInt(month, 10),
    day: parseInt(day, 10),
    hour: hour ? parseInt(hour, 10) : 0,
    minute: minute ? parseInt(minute, 10) : 0,
    second: second ? parseInt(second, 10) : 0,
    microsecond: fraction ? parseInt(fraction.padEnd(6, '0'), 10) : 0,
  };
  validateDate(c.year, c.month, c.day);
  validateTime(c.hour, c.minute, c.second, c.microsecond);
  if (offset) {
    // Deviation from CPython (which would build an aware datetime): convert
    // the instant into the session timezone and keep the result naive.
    let offsetMinutes = 0;
    if (offset !== 'Z') {
      const sign = offset[0] === '-' ? -1 : 1;
      offsetMinutes = sign * (parseInt(offset.slice(1, 3), 10) * 60 + parseInt(offset.slice(4, 6), 10));
    }
    const epochMs = utcMillis(c.year, c.month, c.day, c.hour, c.minute, c.second) - offsetMinutes * 60_000;
    const local = toSessionTz(epochMs);
    local.microsecond = c.microsecond;
    return fromComponents(local);
  }
  return fromComponents(c);
}

// ── Session timezone conversion ──────────────────────────────────────────────

// Intl.DateTimeFormat construction costs ~0.2ms — cache per timezone so
// creating many short-lived interpreters stays cheap.
const tzConverterCache = new Map<string, (ms: number) => Components>();

/** Wall-clock components of an instant in a timezone, asked of Intl every
 *  time. Correct for any instant, but costs microseconds per call. */
export function makeIntlConverter(timezone: string): (ms: number) => Components {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  return (ms: number): Components => {
    const parts: Record<string, number> = {};
    for (const part of formatter.formatToParts(new Date(ms))) {
      if (part.type !== 'literal') parts[part.type] = parseInt(part.value, 10);
    }
    return {
      year: parts.year, month: parts.month, day: parts.day,
      hour: parts.hour, minute: parts.minute, second: parts.second,
      // Sub-second offset of the instant is timezone-independent.
      microsecond: (((ms % 1000) + 1000) % 1000) * 1000,
    };
  };
}

/** How many days to remember per timezone. */
const MAX_CACHED_DAYS = 4096;

const MIN_INSTANT = utcMillis(1, 1, 1);
const MAX_INSTANT = utcMillis(9999, 12, 31, 23, 59, 59) + 999;

/** What is known about one UTC day in a timezone: its constant offset in
 *  ms, that it was asked about once, or that its offset changes (DST). */
type DayOffset = number | 'seen' | 'varies';

/** Wall-clock components of an instant in the given IANA timezone. Throws a
 *  RangeError on an invalid timezone name — callers validate eagerly. */
export function makeTzConverter(timezone: string): (ms: number) => Components {
  const cached = tzConverterCache.get(timezone);
  if (cached) return cached;
  const viaIntl = makeIntlConverter(timezone);

  // A table of tool rows asks about the same days over and over. From the
  // second row of a day on, its offset is reused instead of asking Intl.
  const days = new Map<number, DayOffset>();
  const offsetAt = (ms: number): number => {
    const c = viaIntl(ms);
    return utcMillis(c.year, c.month, c.day, c.hour, c.minute, c.second) - ms;
  };
  const constantOffset = (day: number): number | undefined => {
    let known = days.get(day);
    if (typeof known === 'number') return known;
    if (known === undefined) {
      // Starting over is cheap: a day costs one Intl call the first time,
      // the same as having no cache.
      if (days.size >= MAX_CACHED_DAYS) days.clear();
      known = 'seen';
    } else if (known === 'seen') {
      const start = offsetAt(day * MS_PER_DAY);
      known = start === offsetAt((day + 1) * MS_PER_DAY) ? start : 'varies';
    }
    days.set(day, known);
    return typeof known === 'number' ? known : undefined;
  };

  const converter = (instant: number): Components => {
    if (!(instant >= MIN_INSTANT && instant <= MAX_INSTANT)) {
      throw Number.isFinite(instant)
        ? new OverflowError('date value out of range')
        : new ValueError('invalid date: the timestamp is not a number');
    }
    // A host clock may report fractions of a millisecond; keep them as microseconds.
    const ms = Math.floor(instant);
    const us = Math.floor((instant - ms) * 1000);
    let c: Components;
    if (timezone === 'UTC') {
      c = msUsToComponents(ms, us);
    } else {
      const offset = constantOffset(Math.floor(ms / MS_PER_DAY));
      if (offset !== undefined) {
        c = msUsToComponents(ms + offset, us);
      } else {
        c = viaIntl(ms);
        c.microsecond += us;
      }
    }
    if (c.year < 1 || c.year > 9999) throw new OverflowError('date value out of range');
    return c;
  };
  tzConverterCache.set(timezone, converter);
  return converter;
}

// ── Operators ────────────────────────────────────────────────────────────────

function isDateLike(v: PyValue): v is PyDate | PyDateTime {
  return v instanceof PyDate || v instanceof PyDateTime;
}

function dateFromMs(ms: number): PyDate {
  const c = msUsToComponents(ms, 0);
  return new PyDate(c.year, c.month, c.day);
}

/** Binary operators involving date/datetime/timedelta. Returns undefined to
 *  fall through to the generic unsupported-operand TypeError. */
export function datetimeBinaryOp(op: string, left: PyValue, right: PyValue): PyValue | undefined {
  const leftDelta = left instanceof PyTimeDelta ? left : undefined;
  const rightDelta = right instanceof PyTimeDelta ? right : undefined;
  if (!leftDelta && !rightDelta && !(isDateLike(left) && isDateLike(right))) return undefined;

  if (op === '+') {
    if (leftDelta && rightDelta) {
      const a = timedeltaToMsUs(leftDelta), b = timedeltaToMsUs(rightDelta);
      return makeTimedelta(a.ms + b.ms, a.us + b.us);
    }
    // datetime/date + timedelta is commutative.
    if (leftDelta && isDateLike(right)) return datetimeBinaryOp('+', right, left);
    if (left instanceof PyDateTime && rightDelta) {
      const a = datetimeToMsUs(left), b = timedeltaToMsUs(rightDelta);
      return fromComponents(msUsToComponents(a.ms + b.ms, a.us + b.us));
    }
    if (left instanceof PyDate && rightDelta) {
      // CPython uses only whole days of the timedelta for date arithmetic.
      return dateFromMs(utcMillis(left.year, left.month, left.day) + rightDelta.days * MS_PER_DAY);
    }
  }

  if (op === '-') {
    if (leftDelta && rightDelta) {
      const a = timedeltaToMsUs(leftDelta), b = timedeltaToMsUs(rightDelta);
      return makeTimedelta(a.ms - b.ms, a.us - b.us);
    }
    if (left instanceof PyDateTime && right instanceof PyDateTime) {
      const a = datetimeToMsUs(left), b = datetimeToMsUs(right);
      return makeTimedelta(a.ms - b.ms, a.us - b.us);
    }
    if (left instanceof PyDate && right instanceof PyDate) {
      const days = Math.round((utcMillis(left.year, left.month, left.day) - utcMillis(right.year, right.month, right.day)) / MS_PER_DAY);
      return new PyTimeDelta(days, 0, 0);
    }
    if (left instanceof PyDateTime && rightDelta) {
      const a = datetimeToMsUs(left), b = timedeltaToMsUs(rightDelta);
      return fromComponents(msUsToComponents(a.ms - b.ms, a.us - b.us));
    }
    if (left instanceof PyDate && rightDelta) {
      return dateFromMs(utcMillis(left.year, left.month, left.day) - rightDelta.days * MS_PER_DAY);
    }
  }

  if (op === '*') {
    const td = leftDelta ?? rightDelta!;
    const factor = leftDelta ? right : left;
    if (isNum(factor)) {
      const { ms, us } = timedeltaToMsUs(td);
      return timedeltaFromFloatMs((ms + us / 1000) * toFloat(factor));
    }
  }

  if (op === '/' && leftDelta) {
    const a = timedeltaToMsUs(leftDelta);
    if (isNum(right)) return timedeltaFromFloatMs((a.ms + a.us / 1000) / toFloat(right));
    if (rightDelta) {
      const b = timedeltaToMsUs(rightDelta);
      return new PyFloat((a.ms + a.us / 1000) / (b.ms + b.us / 1000));
    }
  }

  if (op === '//' && leftDelta) {
    const a = timedeltaToMsUs(leftDelta);
    if (typeof right === 'number') return makeTimedelta(0, Math.floor((a.ms * 1000 + a.us) / right));
    if (rightDelta) {
      const b = timedeltaToMsUs(rightDelta);
      return Math.floor((a.ms + a.us / 1000) / (b.ms + b.us / 1000));
    }
  }

  return undefined;
}

export function negateTimedelta(td: PyTimeDelta): PyTimeDelta {
  const { ms, us } = timedeltaToMsUs(td);
  return makeTimedelta(-ms, -us);
}

/** Three-way comparison for same-type date/datetime/timedelta pairs;
 *  undefined when the pair has no ordering, which includes a date against a
 *  datetime, as in CPython. */
export function datetimeOrdering(a: PyValue, b: PyValue): number | undefined {
  if ((a instanceof PyDate && b instanceof PyDate) || (a instanceof PyDateTime && b instanceof PyDateTime)) {
    const x = componentsOf(a), y = componentsOf(b);
    return (
      (x.year - y.year) || (x.month - y.month) || (x.day - y.day) ||
      (x.hour - y.hour) || (x.minute - y.minute) || (x.second - y.second) ||
      (x.microsecond - y.microsecond)
    );
  }
  if (a instanceof PyTimeDelta && b instanceof PyTimeDelta) {
    return (a.days - b.days) || (a.seconds - b.seconds) || (a.microseconds - b.microseconds);
  }
  return undefined;
}

// ── Attribute / method access ────────────────────────────────────────────────

function method(name: string, fn: NativeFn, kw = false): PyBuiltin {
  return new PyBuiltin(name, fn, kw);
}

function intArg(value: PyValue | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'number') throw new TypeError(`'${typeName(value)}' object cannot be interpreted as an integer`);
  return value;
}

function noAttribute(obj: PyValue, attr: string): AttributeError {
  return new AttributeError(`'${typeName(obj)}' object has no attribute '${attr}'`);
}

export function getDatetimeAttr(obj: PyDate | PyDateTime | PyTimeDelta, attr: string): PyValue {
  if (obj instanceof PyTimeDelta) {
    switch (attr) {
      case 'days': return obj.days;
      case 'seconds': return obj.seconds;
      case 'microseconds': return obj.microseconds;
      case 'total_seconds': return method('total_seconds', () =>
        new PyFloat(obj.days * 86400 + obj.seconds + obj.microseconds / 1e6));
    }
    throw noAttribute(obj, attr);
  }

  const c = componentsOf(obj);
  switch (attr) {
    case 'year': return obj.year;
    case 'month': return obj.month;
    case 'day': return obj.day;
    case 'isoformat': return method('isoformat', () =>
      obj instanceof PyDateTime ? isoformatDatetime(obj) : isoformatDate(obj));
    case 'strftime': return method('strftime', (_rt, args) => {
      if (typeof args[0] !== 'string') throw new TypeError('strftime() argument must be str');
      return strftime(c, args[0]);
    });
    case 'weekday': return method('weekday', () => weekdayOf(obj.year, obj.month, obj.day));
    case 'isoweekday': return method('isoweekday', () => weekdayOf(obj.year, obj.month, obj.day) + 1);
    case 'replace': return method('replace', (_rt, _args, kwargs) => {
      const r: Components = {
        year: intArg(kwargs?.get('year'), c.year),
        month: intArg(kwargs?.get('month'), c.month),
        day: intArg(kwargs?.get('day'), c.day),
        hour: intArg(kwargs?.get('hour'), c.hour),
        minute: intArg(kwargs?.get('minute'), c.minute),
        second: intArg(kwargs?.get('second'), c.second),
        microsecond: intArg(kwargs?.get('microsecond'), c.microsecond),
      };
      validateDate(r.year, r.month, r.day);
      validateTime(r.hour, r.minute, r.second, r.microsecond);
      return obj instanceof PyDateTime ? fromComponents(r) : new PyDate(r.year, r.month, r.day);
    }, true);
  }

  if (obj instanceof PyDateTime) {
    switch (attr) {
      case 'hour': return obj.hour;
      case 'minute': return obj.minute;
      case 'second': return obj.second;
      case 'microsecond': return obj.microsecond;
      case 'date': return method('date', () => new PyDate(obj.year, obj.month, obj.day));
      // no time class: `.time` falls through to the attribute error
    }
  }

  throw noAttribute(obj, attr);
}

// ── Module factory ───────────────────────────────────────────────────────────

/** A per-interpreter type object standing in for a shared one, so that
 *  `isinstance(d, date)` holds while `date.today()` uses this session's clock. */
function sessionType(shared: PyType, construct: NativeFn, attrs: [string, PyValue][]): PyType {
  const type = new PyType(shared.name, shared.base, shared.qualName);
  type.canonical = shared;
  type.construct = construct;
  type.attrs = new Map(attrs);
  return type;
}

export function createDatetimeModule(now: () => number, timezone: string): PyModule {
  let toSessionTz: (ms: number) => Components;
  try {
    toSessionTz = makeTzConverter(timezone);
  } catch {
    throw new Error(`Invalid timezone: '${timezone}'. Expected an IANA timezone name like 'Europe/Berlin' or 'UTC'.`);
  }

  const field = (args: PyValue[], kwargs: Kwargs, i: number, name: string, fallback?: number): number => {
    const value = args[i] ?? kwargs?.get(name);
    if (value === undefined) {
      if (fallback === undefined) throw new TypeError(`function missing required argument: '${name}'`);
      return fallback;
    }
    return intArg(value, NaN);
  };

  const datetimeType = sessionType(T_DATETIME, (_rt, args, kwargs) => {
    const c: Components = {
      year: field(args, kwargs, 0, 'year'),
      month: field(args, kwargs, 1, 'month'),
      day: field(args, kwargs, 2, 'day'),
      hour: field(args, kwargs, 3, 'hour', 0),
      minute: field(args, kwargs, 4, 'minute', 0),
      second: field(args, kwargs, 5, 'second', 0),
      microsecond: field(args, kwargs, 6, 'microsecond', 0),
    };
    validateDate(c.year, c.month, c.day);
    validateTime(c.hour, c.minute, c.second, c.microsecond);
    return fromComponents(c);
  }, [
    ['now', method('now', () => fromComponents(toSessionTz(now())))],
    ['utcnow', method('utcnow', () => fromComponents(msUsToComponents(now(), 0)))],
    ['fromisoformat', method('fromisoformat', (_rt, args) => {
      if (typeof args[0] !== 'string') throw new TypeError('fromisoformat: argument must be str');
      return parseIsoDatetime(args[0], toSessionTz);
    })],
    ['strptime', method('strptime', (_rt, args) => {
      if (typeof args[0] !== 'string' || typeof args[1] !== 'string') {
        throw new TypeError('strptime() arguments must be str');
      }
      return fromComponents(strptimeComponents(args[0], args[1]));
    })],
  ]);

  const dateType = sessionType(T_DATE, (_rt, args, kwargs) => {
    const year = field(args, kwargs, 0, 'year');
    const month = field(args, kwargs, 1, 'month');
    const day = field(args, kwargs, 2, 'day');
    validateDate(year, month, day);
    return new PyDate(year, month, day);
  }, [
    ['today', method('today', () => {
      const c = toSessionTz(now());
      return new PyDate(c.year, c.month, c.day);
    })],
    ['fromisoformat', method('fromisoformat', (_rt, args) => {
      const s = args[0];
      if (typeof s !== 'string') throw new TypeError('fromisoformat: argument must be str');
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) throw new ValueError(`Invalid isoformat string: '${s}'`);
      const year = parseInt(m[1], 10), month = parseInt(m[2], 10), day = parseInt(m[3], 10);
      validateDate(year, month, day);
      return new PyDate(year, month, day);
    })],
  ]);

  const TIMEDELTA_KWARGS: Array<[string, number]> = [
    ['days', MS_PER_DAY],
    ['seconds', 1000],
    ['microseconds', 0.001],
    ['milliseconds', 1],
    ['minutes', 60_000],
    ['hours', 3_600_000],
    ['weeks', 7 * MS_PER_DAY],
  ];

  const timedeltaType = sessionType(T_TIMEDELTA, (_rt, args, kwargs) => {
    let totalMs = 0;
    for (let i = 0; i < TIMEDELTA_KWARGS.length; i++) {
      const [name, msPerUnit] = TIMEDELTA_KWARGS[i];
      // Positional order matches CPython: days, seconds, microseconds.
      const value = (i < 3 ? args[i] : undefined) ?? kwargs?.get(name);
      if (value === undefined) continue;
      if (!isNum(value)) throw new TypeError(`unsupported type for timedelta ${name} component: '${typeName(value)}'`);
      totalMs += toFloat(value) * msPerUnit;
    }
    return timedeltaFromFloatMs(totalMs);
  }, []);

  return new PyModule('datetime', new Map<string, PyValue>([
    ['datetime', datetimeType],
    ['date', dateType],
    ['timedelta', timedeltaType],
    ['MINYEAR', 1],
    ['MAXYEAR', 9999],
  ]));
}
