/**
 * Python's numeric tower on top of JS numbers.
 *
 * An int is a JS `number` while it fits in the safe-integer range and a
 * `bigint` beyond it, so int arithmetic is exact at any size. A float is a
 * `PyFloat` wrapper, which is what keeps `3` and `3.0` distinct.
 */

import { MemoryError, OverflowError, ValueError, ZeroDivisionError } from './errors';

export class PyFloat {
  constructor(public readonly v: number) {}
}

export type PyInt = number | bigint;
export type PyNum = number | bigint | boolean | PyFloat;

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_SAFE_BIG = BigInt(MAX_SAFE);
const TWO_52 = 2 ** 52;
/** Largest int a script may build; past this `**` and `<<` raise MemoryError. */
const MAX_INT_BITS = 1_000_000;

export function isNum(v: unknown): v is PyNum {
  const t = typeof v;
  return t === 'number' || t === 'bigint' || t === 'boolean' || v instanceof PyFloat;
}

export function isIntLike(v: unknown): v is number | bigint | boolean {
  const t = typeof v;
  return t === 'number' || t === 'bigint' || t === 'boolean';
}

/** Collapses a bigint back to a number once it fits the safe range. */
export function normBig(b: bigint): PyInt {
  return b >= -MAX_SAFE_BIG && b <= MAX_SAFE_BIG ? Number(b) : b;
}

function asInt(v: number | bigint | boolean): PyInt {
  return typeof v === 'boolean' ? (v ? 1 : 0) : v;
}

export function toFloat(v: PyNum): number {
  if (typeof v === 'number') return v;
  if (v instanceof PyFloat) return v.v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new OverflowError('int too large to convert to float');
  return n;
}

/** Bits needed for the magnitude of `b`; 0 for zero, like int.bit_length(). */
export function bitLength(b: bigint): number {
  return b === 0n ? 0 : (b < 0n ? -b : b).toString(2).length;
}

function checkBits(bits: number): void {
  if (bits > MAX_INT_BITS) throw new MemoryError('integer result is too large');
}

// ── Int arithmetic ──────────────────────────────────────────────────────────

export function intAdd(a: PyInt, b: PyInt): PyInt {
  if (typeof a === 'number' && typeof b === 'number') {
    const r = a + b;
    if (r >= -MAX_SAFE && r <= MAX_SAFE) return r;
  }
  return normBig(BigInt(a) + BigInt(b));
}

export function intSub(a: PyInt, b: PyInt): PyInt {
  if (typeof a === 'number' && typeof b === 'number') {
    const r = a - b;
    if (r >= -MAX_SAFE && r <= MAX_SAFE) return r;
  }
  return normBig(BigInt(a) - BigInt(b));
}

export function intMul(a: PyInt, b: PyInt): PyInt {
  if (typeof a === 'number' && typeof b === 'number') {
    const r = a * b;
    if (r >= -MAX_SAFE && r <= MAX_SAFE) return r === 0 ? 0 : r;
  }
  const x = BigInt(a), y = BigInt(b);
  if (typeof a === 'bigint' || typeof b === 'bigint') checkBits(bitLength(x) + bitLength(y));
  return normBig(x * y);
}

export function intFloorDiv(a: PyInt, b: PyInt): PyInt {
  if (b === 0 || b === 0n) throw new ZeroDivisionError();
  if (typeof a === 'number' && typeof b === 'number' && Math.abs(a) < TWO_52 && Math.abs(b) < TWO_52) {
    const r = intMod(a, b) as number;
    const q = (a - r) / b;
    return q === 0 ? 0 : q;
  }
  const x = BigInt(a), y = BigInt(b);
  let q = x / y;
  if (x % y !== 0n && (x < 0n) !== (y < 0n)) q -= 1n;
  return normBig(q);
}

export function intMod(a: PyInt, b: PyInt): PyInt {
  if (b === 0 || b === 0n) throw new ZeroDivisionError();
  if (typeof a === 'number' && typeof b === 'number') {
    let r = a % b;
    if (r !== 0 && (r < 0) !== (b < 0)) r += b;
    return r === 0 ? 0 : r;
  }
  const x = BigInt(a), y = BigInt(b);
  let r = x % y;
  if (r !== 0n && (r < 0n) !== (y < 0n)) r += y;
  return normBig(r);
}

export function intTrueDiv(a: PyInt, b: PyInt): number {
  if (b === 0 || b === 0n) throw new ZeroDivisionError();
  if (typeof a === 'number' && typeof b === 'number') return a / b;
  // Divide exactly with enough extra bits that one final rounding gives the
  // correctly rounded double, as CPython does. Converting each operand to a
  // double first would round twice (10**25 / 10**24 must be exactly 10.0).
  let x = BigInt(a), y = BigInt(b);
  const negative = (x < 0n) !== (y < 0n);
  if (x < 0n) x = -x;
  if (y < 0n) y = -y;
  const shift = Math.max(0, 56 - (bitLength(x) - bitLength(y)));
  const scaled = x << BigInt(shift);
  let q = scaled / y;
  if (scaled % y !== 0n) q |= 1n;
  // Scale down in steps: 2 ** -shift itself underflows for a tiny quotient.
  let result = Number(q);
  let remaining = shift;
  for (; remaining > 1000; remaining -= 1000) result *= 2 ** -1000;
  result *= 2 ** -remaining;
  if (!Number.isFinite(result)) throw new OverflowError('integer division result too large for a float');
  return negative ? -result : result;
}

/** `a ** b` for ints. A negative exponent gives a float, like CPython. */
export function intPow(a: PyInt, b: PyInt): PyInt | PyFloat {
  if (b < 0) {
    if (a === 0 || a === 0n) throw new ZeroDivisionError('zero to a negative power');
    return new PyFloat(Math.pow(toFloat(a), toFloat(b)));
  }
  if (a === 0 || a === 1 || b === 1) return b === 0 || b === 0n ? 1 : a;
  if (b === 0 || b === 0n) return 1;
  if (a === -1) return BigInt(b) % 2n === 0n ? 1 : -1;
  if (typeof b === 'bigint') throw new MemoryError('integer result is too large');
  const base = BigInt(a);
  const bits = bitLength(base) * b;
  if (bits <= 52 && typeof a === 'number') {
    let r = 1;
    for (let i = 0; i < b; i++) r *= a;
    return r;
  }
  checkBits(bits);
  return normBig(base ** BigInt(b));
}

export function intPowMod(a: PyInt, b: PyInt, m: PyInt): PyInt {
  if (m === 0 || m === 0n) throw new ValueError('pow() 3rd argument cannot be 0');
  const mod = BigInt(m);
  let base = BigInt(a), exp = BigInt(b);
  if (exp < 0n) {
    // A negative exponent means the modular inverse, raised to -exp.
    const modulus = mod < 0n ? -mod : mod;
    let [r0, r1, s0, s1] = [((base % modulus) + modulus) % modulus, modulus, 1n, 0n];
    while (r1 !== 0n) {
      const q = r0 / r1;
      [r0, r1, s0, s1] = [r1, r0 - q * r1, s1, s0 - q * s1];
    }
    if (r0 !== 1n) throw new ValueError('base is not invertible for the given modulus');
    base = s0;
    exp = -exp;
  }
  let result = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  result = ((result % mod) + mod) % mod;
  if (mod < 0n && result !== 0n) result += mod;
  return normBig(result);
}

export function intNeg(a: PyInt): PyInt {
  if (typeof a === 'number') return a === 0 ? 0 : -a;
  return normBig(-a);
}

function isInt32(a: PyInt): a is number {
  return typeof a === 'number' && a >= -0x80000000 && a <= 0x7fffffff;
}

export function intBitwise(op: '&' | '|' | '^', a: PyInt, b: PyInt): PyInt {
  if (isInt32(a) && isInt32(b)) {
    return op === '&' ? a & b : op === '|' ? a | b : a ^ b;
  }
  const x = BigInt(a), y = BigInt(b);
  return normBig(op === '&' ? x & y : op === '|' ? x | y : x ^ y);
}

export function intShift(op: '<<' | '>>', a: PyInt, b: PyInt): PyInt {
  if (b < 0) throw new ValueError('negative shift count');
  if (op === '>>') {
    if (typeof b === 'bigint' || b > MAX_INT_BITS) return a < 0 ? -1 : 0;
    return normBig(BigInt(a) >> BigInt(b));
  }
  if (a === 0 || a === 0n) return 0;
  if (typeof b === 'bigint') throw new MemoryError('integer result is too large');
  if (isInt32(a) && b <= 20) return a * 2 ** b;
  const x = BigInt(a);
  checkBits(bitLength(x) + b);
  return normBig(x << BigInt(b));
}

export function intInvert(a: PyInt): PyInt {
  return intSub(intNeg(a), 1);
}

// ── Float arithmetic ────────────────────────────────────────────────────────

/** Float `//` and `%` together, the way CPython computes them: the quotient
 *  comes from the remainder, so `q * b + r == a` holds (`1.0 // 0.1` is 9.0). */
function floatDivmod(a: number, b: number): [number, number] {
  if (b === 0) throw new ZeroDivisionError();
  let mod = a % b;
  let div = (a - mod) / b;
  if (mod !== 0) {
    if ((b < 0) !== (mod < 0)) {
      mod += b;
      div -= 1;
    }
  } else {
    mod = b < 0 ? -0 : 0;
  }
  let floor: number;
  if (div !== 0) {
    floor = Math.floor(div);
    if (div - floor > 0.5) floor += 1;
  } else {
    floor = a / b < 0 || Object.is(a / b, -0) ? -0 : 0;
  }
  return [floor, mod];
}

function floatPow(a: number, b: number): number {
  if (a === 0 && b < 0) throw new ZeroDivisionError('zero to a negative power');
  if (a < 0 && Number.isFinite(b) && !Number.isInteger(b)) {
    throw new ValueError('negative number cannot be raised to a fractional power (complex numbers are not supported)');
  }
  const r = Math.pow(a, b);
  if (!Number.isFinite(r) && Number.isFinite(a) && Number.isFinite(b)) {
    throw new OverflowError("(34, 'Result too large')");
  }
  return r;
}

// ── Mixed arithmetic ────────────────────────────────────────────────────────

/**
 * Arithmetic on two numbers of any kind. Returns undefined for operators that
 * are not defined for the operand kinds (bitwise ops on floats), so the caller
 * can raise its usual "unsupported operand" TypeError.
 */
export function numBinary(op: string, a: PyNum, b: PyNum): PyInt | PyFloat | undefined {
  if (a instanceof PyFloat || b instanceof PyFloat) {
    const x = toFloat(a), y = toFloat(b);
    switch (op) {
      case '+': return new PyFloat(x + y);
      case '-': return new PyFloat(x - y);
      case '*': return new PyFloat(x * y);
      case '/':
        if (y === 0) throw new ZeroDivisionError();
        return new PyFloat(x / y);
      case '//': return new PyFloat(floatDivmod(x, y)[0]);
      case '%': return new PyFloat(floatDivmod(x, y)[1]);
      case '**': return new PyFloat(floatPow(x, y));
      default: return undefined;
    }
  }
  const x = asInt(a), y = asInt(b);
  switch (op) {
    case '+': return intAdd(x, y);
    case '-': return intSub(x, y);
    case '*': return intMul(x, y);
    case '/': return new PyFloat(intTrueDiv(x, y));
    case '//': return intFloorDiv(x, y);
    case '%': return intMod(x, y);
    case '**': return intPow(x, y);
    case '&': case '|': case '^': return intBitwise(op, x, y);
    case '<<': case '>>': return intShift(op, x, y);
    default: return undefined;
  }
}

const FLOAT_BITS = new DataView(new ArrayBuffer(8));

/** A finite float as an exact fraction: `x === mantissa * 2 ** exponent`. */
export function floatParts(x: number): [mantissa: bigint, exponent: number] {
  FLOAT_BITS.setFloat64(0, x);
  const bits = FLOAT_BITS.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  let mantissa = bits & 0xfffffffffffffn;
  if (biased !== 0) mantissa |= 1n << 52n;
  if (bits >> 63n) mantissa = -mantissa;
  return [mantissa, (biased === 0 ? 1 : biased) - 1075];
}

/** Three-way comparison of two numbers; NaN compares as unordered (NaN). */
export function numCompare(a: PyNum, b: PyNum): number {
  const x = a instanceof PyFloat ? a.v : asInt(a);
  const y = b instanceof PyFloat ? b.v : asInt(b);
  if (x < y) return -1;
  if (x > y) return 1;
  // eslint-disable-next-line eqeqeq
  if (x == y) return 0;
  return NaN;
}

export function numEquals(a: PyNum, b: PyNum): boolean {
  const x = a instanceof PyFloat ? a.v : asInt(a);
  const y = b instanceof PyFloat ? b.v : asInt(b);
  // Loose equality compares a number with a bigint by mathematical value.
  // eslint-disable-next-line eqeqeq
  return x == y;
}

// ── Conversions ─────────────────────────────────────────────────────────────

/** float → int, truncating toward zero. */
export function floatToInt(x: number): PyInt {
  if (Number.isNaN(x)) throw new ValueError('cannot convert float NaN to integer');
  if (!Number.isFinite(x)) throw new OverflowError('cannot convert float infinity to integer');
  const t = Math.trunc(x);
  if (Math.abs(t) <= MAX_SAFE) return t === 0 ? 0 : t;
  return BigInt(t);
}

/** Round to the nearest integer, ties to even (Python's `round(x)`). */
export function roundHalfEven(x: number): number {
  const r = Math.round(x);
  if (Math.abs(x % 1) === 0.5) return 2 * Math.round(x / 2);
  return r;
}

/** `x` with `digits` decimals, exact ties rounded to even like CPython
 *  (JS's toFixed rounds them away from zero: `0.5` → `1`). */
export function toFixedPy(x: number, digits: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'nan' : x > 0 ? 'inf' : '-inf';
  digits = Math.min(digits, 100);
  const negative = x < 0 || Object.is(x, -0);
  const abs = Math.abs(x);
  if (abs >= 1e21) {
    const whole = BigInt(abs).toString();
    return (negative ? '-' : '') + whole + (digits > 0 ? '.' + '0'.repeat(digits) : '');
  }
  let out = abs.toFixed(digits);
  // An exact tie is an odd multiple of half the last decimal place, and that
  // can only be an odd multiple of 2^-(digits+1). The scaling is exact.
  if (digits < 100 && (abs * 2 ** (digits + 1)) % 2 === 1) {
    const truncated = abs.toFixed(digits + 1).slice(0, -1).replace(/\.$/, '');
    const lastDigit = truncated.charCodeAt(truncated.length - 1) - 48;
    if (lastDigit % 2 === 0) out = truncated;
  }
  return (negative ? '-' : '') + out;
}

/** Python's `repr(float)`: shortest round-trip digits, `.0` on whole values. */
export function floatRepr(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const [mantissa, expStr] = x.toExponential().split('e');
  const exp = parseInt(expStr, 10);
  const negative = mantissa[0] === '-';
  const digits = mantissa.replace('-', '').replace('.', '');
  let out: string;
  if (exp >= -4 && exp < 16) {
    if (exp >= 0) {
      out = digits.length <= exp + 1
        ? digits + '0'.repeat(exp + 1 - digits.length) + '.0'
        : digits.slice(0, exp + 1) + '.' + digits.slice(exp + 1);
    } else {
      out = '0.' + '0'.repeat(-exp - 1) + digits;
    }
  } else {
    out = digits[0] + (digits.length > 1 ? '.' + digits.slice(1) : '') +
      'e' + (exp < 0 ? '-' : '+') + String(Math.abs(exp)).padStart(2, '0');
  }
  return negative ? '-' + out : out;
}

/** CPython refuses to convert between str and int past this many decimal
 *  digits, because the conversion is quadratic. */
const MAX_STR_DIGITS = 4300;

/** Decimal text of an int, as str() and repr() produce it. */
export function intToString(v: PyInt): string {
  const text = v.toString();
  if ((v < 0 ? text.length - 1 : text.length) > MAX_STR_DIGITS) {
    throw new ValueError(`Exceeds the limit (${MAX_STR_DIGITS} digits) for integer string conversion; use sys.set_int_max_str_digits() to increase the limit`);
  }
  return text;
}

const DIGIT_VALUES = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Parses an int literal the way `int(s, base)` does: surrounding whitespace,
 * a sign, an optional base prefix and single underscores between digits.
 * Returns undefined when the text is not a valid literal.
 */
export function parseIntString(text: string, base: number = 10): PyInt | undefined {
  let s = text.trim();
  let negative = false;
  if (s[0] === '+' || s[0] === '-') {
    negative = s[0] === '-';
    s = s.slice(1);
  }
  const prefix = s.slice(0, 2).toLowerCase();
  const prefixBase = prefix === '0x' ? 16 : prefix === '0o' ? 8 : prefix === '0b' ? 2 : 0;
  let hadPrefix = false;
  if (base === 0) {
    base = prefixBase || 10;
    hadPrefix = prefixBase !== 0;
  } else {
    hadPrefix = prefixBase === base;
  }
  if (hadPrefix) {
    s = s.slice(2);
    // One underscore may follow the prefix: 0x_ff.
    if (s.startsWith('_')) s = s.slice(1);
  }
  if (s === '' || s.startsWith('_') || s.endsWith('_') || s.includes('__')) return undefined;
  s = s.replace(/_/g, '').toLowerCase();
  if (s.length > MAX_STR_DIGITS && (base & (base - 1)) !== 0) {
    throw new ValueError(`Exceeds the limit (${MAX_STR_DIGITS} digits) for integer string conversion: value has ${s.length} digits; use sys.set_int_max_str_digits() to increase the limit`);
  }
  for (let i = 0; i < s.length; i++) {
    const d = DIGIT_VALUES.indexOf(s[i]);
    if (d < 0 || d >= base) return undefined;
  }
  let value: PyInt;
  if (s.length <= 10) {
    value = parseInt(s, base);
  } else if (base === 10) {
    value = normBig(BigInt(s));
  } else {
    let acc = 0n;
    const b = BigInt(base);
    for (let i = 0; i < s.length; i++) acc = acc * b + BigInt(DIGIT_VALUES.indexOf(s[i]));
    value = normBig(acc);
  }
  return negative ? intNeg(value) : value;
}

/** Parses a float literal the way `float(s)` does; undefined when invalid. */
export function parseFloatString(text: string): number | undefined {
  const s = text.trim().toLowerCase();
  const special = /^([+-]?)(inf|infinity|nan)$/.exec(s);
  if (special) {
    if (special[2] === 'nan') return NaN;
    return special[1] === '-' ? -Infinity : Infinity;
  }
  if (!/^[+-]?(\d+(_\d+)*\.?(\d+(_\d+)*)?|\.\d+(_\d+)*)(e[+-]?\d+(_\d+)*)?$/.test(s)) return undefined;
  return Number(s.replace(/_/g, ''));
}
