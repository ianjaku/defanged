/**
 * String formatting: the format-spec mini-language behind f-strings and
 * format(), `%` formatting, and str.format templates.
 */

import { formatDatetime } from './datetime';
import { IndexError, MemoryError, OverflowError, TypeError, ValueError } from './errors';
import { PyFloat, PyInt, floatRepr, floatToInt, isIntLike, toFixedPy, toFloat } from './numbers';
import {
  PyDate, PyDateTime, PyDict, PyList, PyRange, PyTuple, PyValue,
  dictGet, keyError, pyRepr, pyStr, strLength, typeName,
} from './values';

interface Spec {
  fill: string;
  align: '<' | '>' | '=' | '^' | '';
  sign: '+' | '-' | ' ' | '';
  alternate: boolean;
  width: number;
  grouping: ',' | '_' | '';
  precision: number | undefined;
  type: string;
}

/** Parsed specs by their text; a script reuses a handful of them. */
const specCache = new Map<string, Spec>();

function parseSpec(spec: string, forType: string): Spec {
  let parsed = specCache.get(spec);
  if (parsed === undefined) {
    parsed = parseSpecText(spec, forType);
    if (specCache.size >= 256) specCache.clear();
    specCache.set(spec, parsed);
  }
  return parsed;
}

function parseSpecText(spec: string, forType: string): Spec {
  let i = 0;
  let fill = ' ';
  let align: Spec['align'] = '';
  const chars = Array.from(spec);
  if (chars.length >= 2 && '<>=^'.includes(chars[1])) {
    fill = chars[0];
    align = chars[1] as Spec['align'];
    i = 2;
  } else if (chars.length >= 1 && '<>=^'.includes(chars[0])) {
    align = chars[0] as Spec['align'];
    i = 1;
  }
  const rest = chars.slice(i).join('');
  const m = /^([+\- ])?(z)?(#)?(0)?(\d+)?([,_])?(?:\.(\d+))?([a-zA-Z%])?$/.exec(rest);
  if (!m) throw new ValueError(`Invalid format specifier '${spec}' for object of type '${forType}'`);
  if (m[4] && align === '') {
    fill = '0';
    align = '=';
  }
  if ((m[5] ?? '').length > 7 || (m[7] ?? '').length > 7) throw new ValueError('Too many decimal digits in format string');
  return {
    fill,
    align,
    sign: (m[1] ?? '') as Spec['sign'],
    alternate: m[3] !== undefined,
    width: m[5] ? parseInt(m[5], 10) : 0,
    grouping: (m[6] ?? '') as Spec['grouping'],
    precision: m[7] !== undefined ? parseInt(m[7], 10) : undefined,
    type: m[8] ?? '',
  };
}

/** Widest field a format spec may ask for. */
const MAX_FIELD_WIDTH = 1_000_000;

function pad(body: string, prefix: string, s: Spec, defaultAlign: '<' | '>'): string {
  const length = strLength(prefix) + strLength(body);
  if (s.width <= length) return prefix + body;
  if (s.width > MAX_FIELD_WIDTH) throw new MemoryError(`format width ${s.width} is too large`);
  const padding = s.width - length;
  const align = s.align || defaultAlign;
  switch (align) {
    case '<': return prefix + body + s.fill.repeat(padding);
    case '>': return s.fill.repeat(padding) + prefix + body;
    case '=': return prefix + s.fill.repeat(padding) + body;
    default: {
      const left = Math.floor(padding / 2);
      return s.fill.repeat(left) + prefix + body + s.fill.repeat(padding - left);
    }
  }
}

function group(digits: string, separator: string, size: number): string {
  if (!separator) return digits;
  let out = '';
  for (let i = digits.length; i > 0; i -= size) {
    const chunk = digits.slice(Math.max(0, i - size), i);
    out = out ? chunk + separator + out : chunk;
  }
  return out;
}

function signPrefix(negative: boolean, sign: Spec['sign']): string {
  if (negative) return '-';
  return sign === '+' ? '+' : sign === ' ' ? ' ' : '';
}

function unknownCode(code: string, forType: string): ValueError {
  return new ValueError(`Unknown format code '${code}' for object of type '${forType}'`);
}

function formatInt(v: PyInt, s: Spec): string {
  const negative = v < 0;
  const abs = negative ? -v : v;
  let digits: string;
  let prefix = '';
  switch (s.type) {
    case '': case 'd': case 'n':
      digits = group(abs.toString(), s.grouping, 3);
      break;
    case 'b':
      digits = group(abs.toString(2), s.grouping, 4);
      if (s.alternate) prefix = '0b';
      break;
    case 'o':
      digits = group(abs.toString(8), s.grouping, 4);
      if (s.alternate) prefix = '0o';
      break;
    case 'x': case 'X':
      digits = group(abs.toString(16), s.grouping, 4);
      if (s.type === 'X') digits = digits.toUpperCase();
      if (s.alternate) prefix = s.type === 'X' ? '0X' : '0x';
      break;
    case 'c':
      if (v > 9223372036854775807n || v < -9223372036854775808n) throw new OverflowError('Python int too large to convert to C long');
      if (abs > 0x10ffff || negative) throw new OverflowError('%c arg not in range(0x110000)');
      return pad(String.fromCodePoint(Number(abs)), '', s, '<');
    default:
      throw unknownCode(s.type, 'int');
  }
  if (s.precision !== undefined) throw new ValueError('Precision not allowed in integer format specifier');
  return pad(digits, signPrefix(negative, s.sign) + prefix, s, '>');
}

/** `%e`-style text with Python's two-digit minimum exponent. */
function exponential(abs: number, precision: number): string {
  const [mantissa, exp] = abs.toExponential(Math.min(precision, 100)).split('e');
  const e = parseInt(exp, 10);
  return `${mantissa}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
}

function general(abs: number, precision: number, alternate: boolean): string {
  const p = precision === 0 ? 1 : precision;
  if (abs === 0) return alternate ? '0.' + '0'.repeat(p - 1) : '0';
  const exp = parseInt(abs.toExponential(p - 1).split('e')[1], 10);
  let out: string;
  if (exp >= -4 && exp < p) {
    out = toFixedPy(abs, Math.max(0, p - 1 - exp));
    if (!alternate && out.includes('.')) out = out.replace(/\.?0+$/, '');
  } else {
    out = exponential(abs, p - 1);
    if (!alternate) out = out.replace(/\.?0+e/, 'e');
  }
  return out;
}

function formatFloat(x: number, s: Spec): string {
  const negative = x < 0 || Object.is(x, -0);
  const abs = Math.abs(x);
  let body: string;
  if (!Number.isFinite(x)) {
    body = Number.isNaN(x) ? 'nan' : 'inf';
    if ('EFG'.includes(s.type) && s.type !== '') body = body.toUpperCase();
    if (s.type === '%') body += '%';
    // Zero padding applies to inf and nan too: format(inf, '08.2f') is '00000inf'.
    return pad(body, signPrefix(negative && !Number.isNaN(x), s.sign), s, '>');
  }
  switch (s.type) {
    case 'f': case 'F':
      body = toFixedPy(abs, s.precision ?? 6);
      break;
    case 'e': case 'E':
      body = exponential(abs, s.precision ?? 6);
      if (s.type === 'E') body = body.toUpperCase();
      break;
    case 'g': case 'G': case 'n':
      body = general(abs, s.precision ?? 6, s.alternate);
      if (s.type === 'G') body = body.toUpperCase();
      break;
    case '%':
      body = toFixedPy(abs * 100, s.precision ?? 6) + '%';
      break;
    case '':
      if (s.precision === undefined) {
        body = floatRepr(abs);
      } else {
        body = general(abs, s.precision, s.alternate);
        if (!/[.e]/.test(body)) body += '.0';
      }
      break;
    default:
      throw unknownCode(s.type, 'float');
  }
  if (s.alternate && s.precision === 0 && !body.includes('.') && 'fFeE%'.includes(s.type)) {
    body = body.replace(/^(\d+)/, '$1.');
  }
  if (s.grouping) {
    const m = /^(\d+)(.*)$/s.exec(body)!;
    body = group(m[1], s.grouping, 3) + m[2];
  }
  return pad(body, signPrefix(negative, s.sign), s, '>');
}

/** `format(value, spec)`: what an f-string field or str.format field renders. */
export function formatValue(v: PyValue, spec: string): string {
  if (spec === '') return pyStr(v);
  if (v instanceof PyDate || v instanceof PyDateTime) return formatDatetime(v, spec);

  if (typeof v === 'string') {
    const s = parseSpec(spec, 'str');
    if (s.type !== '' && s.type !== 's') throw unknownCode(s.type, 'str');
    if (s.sign) throw new ValueError('Sign not allowed in string format specifier');
    if (s.alternate) throw new ValueError('Alternate form (#) not allowed in string format specifier');
    if (s.align === '=') throw new ValueError("'=' alignment not allowed in string format specifier");
    if (s.grouping) throw new ValueError(`Cannot specify '${s.grouping}' with 's'.`);
    const text = s.precision !== undefined ? Array.from(v).slice(0, s.precision).join('') : v;
    return pad(text, '', s, '<');
  }
  if (isIntLike(v)) {
    const s = parseSpec(spec, 'int');
    const n: PyInt = typeof v === 'boolean' ? (v ? 1 : 0) : v;
    if (s.type !== '' && 'eEfFgG%'.includes(s.type)) return formatFloat(toFloat(n), s);
    if (s.type === 's') throw unknownCode('s', typeName(v));
    return formatInt(n, s);
  }
  if (v instanceof PyFloat) {
    const s = parseSpec(spec, 'float');
    if (s.type !== '' && !'eEfFgGn%'.includes(s.type)) throw unknownCode(s.type, 'float');
    return formatFloat(v.v, s);
  }
  throw new TypeError(`unsupported format string passed to ${typeName(v)}.__format__`);
}

/** repr() with every non-ASCII character escaped. */
export function asciiRepr(v: PyValue): string {
  let out = '';
  for (const ch of pyRepr(v)) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out += ch;
    else if (c <= 0xff) out += '\\x' + c.toString(16).padStart(2, '0');
    else if (c <= 0xffff) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += '\\U' + c.toString(16).padStart(8, '0');
  }
  return out;
}

// ── printf-style `%` formatting ─────────────────────────────────────────────

function percentNumber(v: PyValue, code: string): PyInt | PyFloat {
  if (isIntLike(v)) return typeof v === 'boolean' ? (v ? 1 : 0) : v;
  if (v instanceof PyFloat) return v;
  // The float codes go through float() and report its error.
  if ('fFeEgG'.includes(code)) throw new TypeError(`must be real number, not ${typeName(v)}`);
  const what = 'xXo'.includes(code) ? 'an integer' : 'a real number';
  throw new TypeError(`%${code} format: ${what} is required, not ${typeName(v)}`);
}

/** `%c`: one character, or a code point as an int. */
function percentChar(v: PyValue): string {
  if (typeof v === 'string') {
    if (strLength(v) !== 1) throw new TypeError(`%c requires an int or a unicode character, not a string of length ${strLength(v)}`);
    return v;
  }
  if (!isIntLike(v)) throw new TypeError(`%c requires an int or a unicode character, not ${typeName(v)}`);
  const n = typeof v === 'boolean' ? (v ? 1 : 0) : v;
  if (n < 0 || n > 0x10ffff) throw new OverflowError('%c arg not in range(0x110000)');
  return String.fromCodePoint(Number(n));
}

function checkStray(format: string, from: number, to: number): void {
  const at = format.indexOf('%', from);
  if (at < 0 || at >= to) return;
  // Skip the flags, width and precision to name the character that is wrong.
  const m = /^%(?:\([^)]*\))?[-+ 0#]*(?:\*|\d+)?(?:\.(?:\*|\d+))?/.exec(format.slice(at))!;
  const bad = format[at + m[0].length];
  // A '.' with nothing after it is still an unfinished conversion.
  if (bad === undefined || (bad === '.' && at + m[0].length === format.length - 1)) throw new ValueError('incomplete format');
  throw new ValueError(`unsupported format character '${bad}' (0x${bad.charCodeAt(0).toString(16)}) at index ${at + m[0].length}`);
}

/** Python's `format % values`. */
export function percentFormat(format: string, values: PyValue): string {
  const positional = values instanceof PyTuple ? values.items : [values];
  // Anything subscriptable but a tuple or str counts as a mapping, so `'a' % []` is 'a'.
  const mapping = values instanceof PyDict || values instanceof PyList || values instanceof PyRange;
  let next = 0;
  let usedMapping = false;
  const re = /%(?:\(([^)]*)\))?([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d+))?([a-zA-Z%])/g;

  const takeNext = (): PyValue => {
    if (next >= positional.length) throw new TypeError('not enough arguments for format string');
    return positional[next++];
  };
  const takeInt = (): number => {
    const v = takeNext();
    if (typeof v !== 'number') throw new TypeError('* wants int');
    return v;
  };

  // A '%' outside the conversions the pattern reads is an error, not text.
  let last = 0;
  for (const m of format.matchAll(re)) {
    checkStray(format, last, m.index);
    last = m.index + m[0].length;
  }
  checkStray(format, last, format.length);
  const out = format.replace(re, (_match, key: string | undefined, flags: string, width: string | undefined, precision: string | undefined, code: string) => {
    if (code === '%') return '%';
    const s: Spec = {
      fill: ' ',
      align: flags.includes('-') ? '<' : flags.includes('0') ? '=' : '',
      sign: flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '',
      alternate: flags.includes('#'),
      width: width === undefined ? 0 : width === '*' ? takeInt() : parseInt(width, 10),
      grouping: '',
      precision: precision === undefined ? undefined : precision === '*' ? takeInt() : parseInt(precision, 10),
      type: code,
    };
    if (s.align === '=') s.fill = '0';

    let value: PyValue;
    if (key !== undefined) {
      if (!mapping) throw new TypeError('format requires a mapping');
      usedMapping = true;
      if (!(values instanceof PyDict)) throw new TypeError(`${typeName(values)} indices must be integers or slices, not str`);
      const found = dictGet(values as PyDict, key);
      if (found === undefined) throw keyError(key);
      value = found;
    } else {
      value = takeNext();
    }

    switch (code) {
      case 's': case 'r': case 'a': {
        let text = code === 's' ? pyStr(value) : code === 'r' ? pyRepr(value) : asciiRepr(value);
        if (s.precision !== undefined) text = Array.from(text).slice(0, s.precision).join('');
        return pad(text, '', { ...s, fill: ' ', align: s.align === '<' ? '<' : '>' }, '>');
      }
      case 'd': case 'i': case 'u': {
        const n = percentNumber(value, code);
        const whole: PyInt = n instanceof PyFloat ? floatToInt(n.v) : n;
        return formatInt(whole, { ...s, type: 'd', precision: undefined });
      }
      case 'x': case 'X': case 'o': {
        const n = percentNumber(value, code);
        if (n instanceof PyFloat) throw new TypeError(`%${code} format: an integer is required, not float`);
        return formatInt(n, { ...s, precision: undefined });
      }
      case 'f': case 'F': case 'e': case 'E': case 'g': case 'G':
        return formatFloat(toFloat(percentNumber(value, code)), s);
      case 'c':
        return pad(percentChar(value), '', { ...s, fill: ' ' }, '>');
      default:
        throw new ValueError(`unsupported format character '${code}'`);
    }
  });

  if (!usedMapping && next < positional.length && !mapping) {
    throw new TypeError('not all arguments converted during string formatting');
  }
  return out;
}

// ── str.format ──────────────────────────────────────────────────────────────

export type AttributeGetter = (obj: PyValue, name: string) => PyValue;
export type ItemGetter = (obj: PyValue, key: PyValue) => PyValue;

/** Python's `template.format(*args, **kwargs)`. */
export function strFormat(
  template: string,
  args: PyValue[],
  kwargs: Map<string, PyValue> | null,
  getAttr: AttributeGetter,
  getItem: ItemGetter,
): string {
  let auto = 0;

  const lookup = (field: string): PyValue => {
    const m = /^([^.[]*)(.*)$/s.exec(field)!;
    const head = m[1];
    let value: PyValue;
    if (head === '' || /^\d+$/.test(head)) {
      const index = head === '' ? auto++ : parseInt(head, 10);
      if (index >= args.length) {
        throw new IndexError(`Replacement index ${index} out of range for positional args tuple`);
      }
      value = args[index];
    } else {
      const found = kwargs?.get(head);
      if (found === undefined) throw keyError(head);
      value = found;
    }
    const accessors = /\.([^.[]+)|\[([^\]]*)\]/g;
    for (let a = accessors.exec(m[2]); a; a = accessors.exec(m[2])) {
      if (a[1] !== undefined) value = getAttr(value, a[1]);
      else value = getItem(value, /^-?\d+$/.test(a[2]) ? parseInt(a[2], 10) : a[2]);
    }
    return value;
  };

  const render = (text: string, depth: number): string => {
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '{') {
        if (text[i + 1] === '{') { out += '{'; i++; continue; }
        // Find the matching brace, allowing one nested level in the spec.
        let level = 1;
        let j = i + 1;
        for (; j < text.length && level > 0; j++) {
          if (text[j] === '{') level++;
          else if (text[j] === '}') level--;
        }
        if (level > 0) throw new ValueError("Single '{' encountered in format string");
        const field = text.slice(i + 1, j - 1);
        i = j - 1;
        const colon = field.indexOf(':');
        const beforeSpec = colon >= 0 ? field.slice(0, colon) : field;
        let spec = colon >= 0 ? field.slice(colon + 1) : '';
        const bang = beforeSpec.indexOf('!');
        const name = bang >= 0 ? beforeSpec.slice(0, bang) : beforeSpec;
        const conversion = bang >= 0 ? beforeSpec.slice(bang + 1) : '';
        // The field takes its number before any `{}` nested in its spec.
        let value = lookup(name);
        if (spec.includes('{')) {
          if (depth > 0) throw new ValueError('Max string recursion exceeded');
          spec = render(spec, depth + 1);
        }
        if (conversion === 'r') value = pyRepr(value);
        else if (conversion === 's') value = pyStr(value);
        else if (conversion === 'a') value = asciiRepr(value);
        else if (conversion !== '') throw new ValueError(`Unknown conversion specifier ${conversion}`);
        out += formatValue(value, spec);
      } else if (c === '}') {
        if (text[i + 1] !== '}') throw new ValueError("Single '}' encountered in format string");
        out += '}';
        i++;
      } else {
        out += c;
      }
    }
    return out;
  };

  return render(template, 0);
}
