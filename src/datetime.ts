/**
 * The whitelisted `datetime` module: date, datetime, timedelta.
 *
 * All values are naive (no tzinfo). The host-provided session timezone only
 * affects datetime.now() / date.today() and parsing of offset-bearing ISO
 * strings — everything else is pure calendar arithmetic, like CPython's
 * naive datetimes.
 */

import {
  PyValue,
  PyBuiltin,
  PyDate,
  PyDateTime,
  PyTimeDelta,
  PyModule,
  pyNumber,
  pyString,
  pyDate,
  pyDatetime,
  pyTimedelta,
  isNumber,
  isString,
  isDate,
  isDatetime,
  isTimedelta,
  pyTypeName,
} from './values';
import { extractKwargs } from './builtins';
import { TypeError, ValueError } from './errors';

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

function validateDate(year: number, month: number, day: number, line: number, column: number): void {
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    throw new ValueError(`year ${year} is out of range`, line, column);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new ValueError('month must be in 1..12', line, column);
  }
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) {
    throw new ValueError('day is out of range for month', line, column);
  }
}

function validateTime(hour: number, minute: number, second: number, microsecond: number, line: number, column: number): void {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new ValueError('hour must be in 0..23', line, column);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new ValueError('minute must be in 0..59', line, column);
  if (!Number.isInteger(second) || second < 0 || second > 59) throw new ValueError('second must be in 0..59', line, column);
  if (!Number.isInteger(microsecond) || microsecond < 0 || microsecond > 999999) {
    throw new ValueError('microsecond must be in 0..999999', line, column);
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
  return pyTimedelta(days, seconds, microseconds);
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
  switch (value.type) {
    case 'date':
      return `datetime.date(${value.year}, ${value.month}, ${value.day})`;
    case 'datetime': {
      // CPython always shows hour and minute, appends second and microsecond
      // only when needed.
      const parts = [value.year, value.month, value.day, value.hour, value.minute];
      if (value.second || value.microsecond) parts.push(value.second);
      if (value.microsecond) parts.push(value.microsecond);
      return `datetime.datetime(${parts.join(', ')})`;
    }
    case 'timedelta': {
      const parts: string[] = [];
      if (value.days) parts.push(`days=${value.days}`);
      if (value.seconds) parts.push(`seconds=${value.seconds}`);
      if (value.microseconds) parts.push(`microseconds=${value.microseconds}`);
      return parts.length ? `datetime.timedelta(${parts.join(', ')})` : 'datetime.timedelta(0)';
    }
  }
}

export function datetimeStr(value: PyDate | PyDateTime | PyTimeDelta): string {
  switch (value.type) {
    case 'date':
      return isoformatDate(value);
    case 'datetime':
      return isoformatDatetime(value, ' ');
    case 'timedelta': {
      const hours = Math.floor(value.seconds / 3600);
      const minutes = Math.floor((value.seconds % 3600) / 60);
      const seconds = value.seconds % 60;
      let s = `${hours}:${pad(minutes, 2)}:${pad(seconds, 2)}`;
      if (value.microseconds) s += `.${pad(value.microseconds, 6)}`;
      if (value.days) s = `${value.days} day${Math.abs(value.days) !== 1 ? 's' : ''}, ${s}`;
      return s;
    }
  }
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

function strptimeComponents(s: string, fmt: string, line: number, column: number): Components {
  let pattern = '';
  const fields: string[] = [];
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] === '%' && i < fmt.length - 1) {
      const code = fmt[++i];
      if (code === '%') {
        pattern += '%';
      } else if (STRPTIME_PATTERNS[code]) {
        pattern += STRPTIME_PATTERNS[code];
        fields.push(code);
      } else {
        throw new ValueError(`'${code}' is a bad directive in format '${fmt}'`, line, column);
      }
    } else {
      pattern += escapeRegex(fmt[i]);
    }
  }
  const match = s.match(new RegExp(`^${pattern}$`, 'i'));
  if (!match) {
    throw new ValueError(`time data '${s}' does not match format '${fmt}'`, line, column);
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
  validateDate(c.year, c.month, c.day, line, column);
  validateTime(c.hour, c.minute, c.second, c.microsecond, line, column);
  return c;
}

// ── ISO parsing ──────────────────────────────────────────────────────────────

const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?(Z|[+-]\d{2}:\d{2})?$/;

function parseIsoDatetime(
  s: string,
  toSessionTz: (ms: number) => Components,
  line: number,
  column: number
): PyDateTime {
  const m = s.match(ISO_DATETIME);
  if (!m) throw new ValueError(`Invalid isoformat string: '${s}'`, line, column);
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
  validateDate(c.year, c.month, c.day, line, column);
  validateTime(c.hour, c.minute, c.second, c.microsecond, line, column);
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
    return pyDatetime(local);
  }
  return pyDatetime(c);
}

// ── Session timezone conversion ──────────────────────────────────────────────

// Intl.DateTimeFormat construction costs ~0.2ms — cache per timezone so
// creating many short-lived interpreters stays cheap.
const tzConverterCache = new Map<string, (ms: number) => Components>();

/** Wall-clock components of an instant in the given IANA timezone. Throws a
 *  RangeError on an invalid timezone name — callers validate eagerly. */
export function makeTzConverter(timezone: string): (ms: number) => Components {
  const cached = tzConverterCache.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  const converter = (ms: number): Components => {
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
  tzConverterCache.set(timezone, converter);
  return converter;
}

// ── Operators ────────────────────────────────────────────────────────────────

export function isDatetimeLike(value: PyValue): value is PyDate | PyDateTime | PyTimeDelta {
  return value.type === 'date' || value.type === 'datetime' || value.type === 'timedelta';
}

/** Binary operators involving date/datetime/timedelta. Returns null to fall
 *  through to the interpreter's generic unsupported-operand TypeError. */
export function datetimeBinaryOp(op: string, left: PyValue, right: PyValue, line: number, column: number): PyValue | null {
  if (op === '+') {
    if (isTimedelta(left) && isTimedelta(right)) {
      const a = timedeltaToMsUs(left), b = timedeltaToMsUs(right);
      return makeTimedelta(a.ms + b.ms, a.us + b.us);
    }
    // datetime/date + timedelta is commutative.
    if (isTimedelta(left) && (isDatetime(right) || isDate(right))) {
      return datetimeBinaryOp('+', right, left, line, column);
    }
    if (isDatetime(left) && isTimedelta(right)) {
      const a = datetimeToMsUs(left), b = timedeltaToMsUs(right);
      return pyDatetime(msUsToComponents(a.ms + b.ms, a.us + b.us));
    }
    if (isDate(left) && isTimedelta(right)) {
      // CPython uses only whole days of the timedelta for date arithmetic.
      const c = msUsToComponents(utcMillis(left.year, left.month, left.day) + right.days * MS_PER_DAY, 0);
      return pyDate(c.year, c.month, c.day);
    }
  }

  if (op === '-') {
    if (isTimedelta(left) && isTimedelta(right)) {
      const a = timedeltaToMsUs(left), b = timedeltaToMsUs(right);
      return makeTimedelta(a.ms - b.ms, a.us - b.us);
    }
    if (isDatetime(left) && isDatetime(right)) {
      const a = datetimeToMsUs(left), b = datetimeToMsUs(right);
      return makeTimedelta(a.ms - b.ms, a.us - b.us);
    }
    if (isDate(left) && isDate(right)) {
      const days = Math.round((utcMillis(left.year, left.month, left.day) - utcMillis(right.year, right.month, right.day)) / MS_PER_DAY);
      return pyTimedelta(days, 0, 0);
    }
    if (isDatetime(left) && isTimedelta(right)) {
      const a = datetimeToMsUs(left), b = timedeltaToMsUs(right);
      return pyDatetime(msUsToComponents(a.ms - b.ms, a.us - b.us));
    }
    if (isDate(left) && isTimedelta(right)) {
      const c = msUsToComponents(utcMillis(left.year, left.month, left.day) - right.days * MS_PER_DAY, 0);
      return pyDate(c.year, c.month, c.day);
    }
  }

  if (op === '*') {
    const td = isTimedelta(left) ? left : isTimedelta(right) ? right : null;
    const num = isNumber(left) ? left : isNumber(right) ? right : null;
    if (td && num) {
      const { ms, us } = timedeltaToMsUs(td);
      return timedeltaFromFloatMs((ms + us / 1000) * num.value);
    }
  }

  if (op === '/' && isTimedelta(left)) {
    const a = timedeltaToMsUs(left);
    if (isNumber(right)) {
      return timedeltaFromFloatMs((a.ms + a.us / 1000) / right.value);
    }
    if (isTimedelta(right)) {
      const b = timedeltaToMsUs(right);
      return pyNumber((a.ms + a.us / 1000) / (b.ms + b.us / 1000));
    }
  }

  if (op === '//' && isTimedelta(left)) {
    const a = timedeltaToMsUs(left);
    if (isNumber(right) && Number.isInteger(right.value)) {
      return makeTimedelta(0, Math.floor((a.ms * 1000 + a.us) / right.value));
    }
    if (isTimedelta(right)) {
      const b = timedeltaToMsUs(right);
      return pyNumber(Math.floor((a.ms + a.us / 1000) / (b.ms + b.us / 1000)));
    }
  }

  return null;
}

export function negateTimedelta(td: PyTimeDelta): PyTimeDelta {
  const { ms, us } = timedeltaToMsUs(td);
  return makeTimedelta(-ms, -us);
}

/** Three-way comparison for same-type date/datetime/timedelta pairs; null when
 *  the pair is not ordering-comparable by this module. Mixing date and
 *  datetime raises, matching CPython. */
export function datetimeOrdering(a: PyValue, b: PyValue, line: number, column: number): number | null {
  if ((isDate(a) && isDatetime(b)) || (isDatetime(a) && isDate(b))) {
    throw new TypeError("can't compare datetime.datetime to datetime.date", line, column);
  }
  if (a.type !== b.type) return null;
  if (isDate(a) || isDatetime(a)) {
    const da = a as PyDateTime, db = b as PyDateTime;
    return (
      (da.year - db.year) ||
      (da.month - db.month) ||
      (da.day - db.day) ||
      ((da.hour ?? 0) - (db.hour ?? 0)) ||
      ((da.minute ?? 0) - (db.minute ?? 0)) ||
      ((da.second ?? 0) - (db.second ?? 0)) ||
      ((da.microsecond ?? 0) - (db.microsecond ?? 0))
    );
  }
  if (isTimedelta(a)) {
    const ta = a as PyTimeDelta, tb = b as PyTimeDelta;
    return (ta.days - tb.days) || (ta.seconds - tb.seconds) || (ta.microseconds - tb.microseconds);
  }
  return null;
}

// ── Attribute / method access ────────────────────────────────────────────────

const TYPE_DISPLAY: Record<string, string> = {
  date: 'datetime.date',
  datetime: 'datetime.datetime',
  timedelta: 'datetime.timedelta',
};

function method(name: string, fn: PyBuiltin['fn'], acceptsKwargs = false): PyBuiltin {
  return { type: 'builtin', name, fn, acceptsKwargs };
}

function intArg(value: PyValue | undefined, name: string, fallback: number, line: number, column: number): number {
  if (value === undefined) return fallback;
  if (!isNumber(value) || !Number.isInteger(value.value)) {
    throw new TypeError(`an integer is required (got ${name})`, line, column);
  }
  return value.value;
}

export function getDatetimeAttr(obj: PyDate | PyDateTime | PyTimeDelta, attr: string, line: number, column: number): PyValue {
  if (isTimedelta(obj)) {
    switch (attr) {
      case 'days': return pyNumber(obj.days);
      case 'seconds': return pyNumber(obj.seconds);
      case 'microseconds': return pyNumber(obj.microseconds);
      case 'total_seconds': return method('timedelta.total_seconds', () =>
        pyNumber(obj.days * 86400 + obj.seconds + obj.microseconds / 1e6));
    }
    throw new TypeError(`'${TYPE_DISPLAY[obj.type]}' object has no attribute '${attr}'`, line, column);
  }

  const c: Components = isDatetime(obj)
    ? obj
    : { year: obj.year, month: obj.month, day: obj.day, hour: 0, minute: 0, second: 0, microsecond: 0 };

  switch (attr) {
    case 'year': return pyNumber(obj.year);
    case 'month': return pyNumber(obj.month);
    case 'day': return pyNumber(obj.day);
    case 'isoformat': return method(`${TYPE_DISPLAY[obj.type]}.isoformat`, () =>
      pyString(isDatetime(obj) ? isoformatDatetime(obj) : isoformatDate(obj)));
    case 'strftime': return method(`${TYPE_DISPLAY[obj.type]}.strftime`, (fmt: PyValue) => {
      if (!isString(fmt)) throw new TypeError('strftime() argument must be str', line, column);
      return pyString(strftime(c, fmt.value));
    });
    case 'weekday': return method(`${TYPE_DISPLAY[obj.type]}.weekday`, () =>
      pyNumber(weekdayOf(obj.year, obj.month, obj.day)));
    case 'replace': return method(`${TYPE_DISPLAY[obj.type]}.replace`, (...rawArgs: any[]) => {
      const { kwargs } = extractKwargs(rawArgs);
      const r: Components = {
        year: intArg(kwargs.year, 'year', c.year, line, column),
        month: intArg(kwargs.month, 'month', c.month, line, column),
        day: intArg(kwargs.day, 'day', c.day, line, column),
        hour: intArg(kwargs.hour, 'hour', c.hour, line, column),
        minute: intArg(kwargs.minute, 'minute', c.minute, line, column),
        second: intArg(kwargs.second, 'second', c.second, line, column),
        microsecond: intArg(kwargs.microsecond, 'microsecond', c.microsecond, line, column),
      };
      validateDate(r.year, r.month, r.day, line, column);
      validateTime(r.hour, r.minute, r.second, r.microsecond, line, column);
      return isDatetime(obj) ? pyDatetime(r) : pyDate(r.year, r.month, r.day);
    }, true);
  }

  if (isDatetime(obj)) {
    switch (attr) {
      case 'hour': return pyNumber(obj.hour);
      case 'minute': return pyNumber(obj.minute);
      case 'second': return pyNumber(obj.second);
      case 'microsecond': return pyNumber(obj.microsecond);
      case 'date': return method('datetime.datetime.date', () => pyDate(obj.year, obj.month, obj.day));
      case 'time': break; // no time class — fall through to the attribute error
    }
  }

  throw new TypeError(`'${TYPE_DISPLAY[obj.type]}' object has no attribute '${attr}'`, line, column);
}

// ── Module factory ───────────────────────────────────────────────────────────

export function createDatetimeModule(now: () => number, timezone: string): PyModule {
  let toSessionTz: (ms: number) => Components;
  try {
    toSessionTz = makeTzConverter(timezone);
  } catch {
    throw new Error(`Invalid timezone: '${timezone}'. Expected an IANA timezone name like 'Europe/Berlin' or 'UTC'.`);
  }

  const datetimeCtor: PyBuiltin = {
    type: 'builtin',
    name: 'datetime.datetime',
    acceptsKwargs: true,
    fn: (...rawArgs: any[]) => {
      const { args, kwargs } = extractKwargs(rawArgs);
      const get = (i: number, name: string, fallback?: number): number => {
        const value = args[i] ?? kwargs[name];
        if (value === undefined) {
          if (fallback === undefined) throw new TypeError(`function missing required argument: '${name}'`, 0, 0);
          return fallback;
        }
        return intArg(value, name, NaN, 0, 0);
      };
      const c: Components = {
        year: get(0, 'year'),
        month: get(1, 'month'),
        day: get(2, 'day'),
        hour: get(3, 'hour', 0),
        minute: get(4, 'minute', 0),
        second: get(5, 'second', 0),
        microsecond: get(6, 'microsecond', 0),
      };
      validateDate(c.year, c.month, c.day, 0, 0);
      validateTime(c.hour, c.minute, c.second, c.microsecond, 0, 0);
      return pyDatetime(c);
    },
    attrs: new Map<string, PyValue>([
      ['now', method('datetime.datetime.now', () => pyDatetime(toSessionTz(now())))],
      ['utcnow', method('datetime.datetime.utcnow', () => pyDatetime(msUsToComponents(now(), 0)))],
      ['fromisoformat', method('datetime.datetime.fromisoformat', (s: PyValue) => {
        if (!isString(s)) throw new TypeError('fromisoformat: argument must be str', 0, 0);
        return parseIsoDatetime(s.value, toSessionTz, 0, 0);
      })],
      ['strptime', method('datetime.datetime.strptime', (s: PyValue, fmt: PyValue) => {
        if (!isString(s) || !isString(fmt)) throw new TypeError('strptime() arguments must be str', 0, 0);
        return pyDatetime(strptimeComponents(s.value, fmt.value, 0, 0));
      })],
    ]),
  };

  const dateCtor: PyBuiltin = {
    type: 'builtin',
    name: 'datetime.date',
    acceptsKwargs: true,
    fn: (...rawArgs: any[]) => {
      const { args, kwargs } = extractKwargs(rawArgs);
      const get = (i: number, name: string): number => {
        const value = args[i] ?? kwargs[name];
        if (value === undefined) throw new TypeError(`function missing required argument: '${name}'`, 0, 0);
        return intArg(value, name, NaN, 0, 0);
      };
      const year = get(0, 'year'), month = get(1, 'month'), day = get(2, 'day');
      validateDate(year, month, day, 0, 0);
      return pyDate(year, month, day);
    },
    attrs: new Map<string, PyValue>([
      ['today', method('datetime.date.today', () => {
        const c = toSessionTz(now());
        return pyDate(c.year, c.month, c.day);
      })],
      ['fromisoformat', method('datetime.date.fromisoformat', (s: PyValue) => {
        if (!isString(s)) throw new TypeError('fromisoformat: argument must be str', 0, 0);
        const m = s.value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) throw new ValueError(`Invalid isoformat string: '${s.value}'`, 0, 0);
        const year = parseInt(m[1], 10), month = parseInt(m[2], 10), day = parseInt(m[3], 10);
        validateDate(year, month, day, 0, 0);
        return pyDate(year, month, day);
      })],
    ]),
  };

  const TIMEDELTA_KWARGS: Array<[string, number]> = [
    ['days', MS_PER_DAY],
    ['seconds', 1000],
    ['microseconds', 0.001],
    ['milliseconds', 1],
    ['minutes', 60_000],
    ['hours', 3_600_000],
    ['weeks', 7 * MS_PER_DAY],
  ];

  const timedeltaCtor: PyBuiltin = {
    type: 'builtin',
    name: 'datetime.timedelta',
    acceptsKwargs: true,
    fn: (...rawArgs: any[]) => {
      const { args, kwargs } = extractKwargs(rawArgs);
      let totalMs = 0;
      for (let i = 0; i < TIMEDELTA_KWARGS.length; i++) {
        const [name, msPerUnit] = TIMEDELTA_KWARGS[i];
        // Positional order matches CPython: days, seconds, microseconds.
        const value = (i < 3 ? args[i] : undefined) ?? kwargs[name];
        if (value === undefined) continue;
        if (!isNumber(value)) throw new TypeError(`unsupported type for timedelta ${name} component: '${pyTypeName(value)}'`, 0, 0);
        totalMs += value.value * msPerUnit;
      }
      return timedeltaFromFloatMs(totalMs);
    },
  };

  return {
    type: 'module',
    name: 'datetime',
    attrs: new Map<string, PyValue>([
      ['datetime', datetimeCtor],
      ['date', dateCtor],
      ['timedelta', timedeltaCtor],
      ['MINYEAR', pyNumber(1)],
      ['MAXYEAR', pyNumber(9999)],
    ]),
  };
}
