/**
 * The `json` module: `dumps` and `loads`, as an opt-in plugin.
 *
 *   import { json } from 'defanged/json';
 *   createInterpreter({ modules: [json] });
 *
 * `load`/`dump` take files and so do not exist here. Pure computation, no
 * state: the module object is a process-wide singleton.
 */

import { TypeError, ValueError, defineException } from './errors';
import { PyFloat, floatRepr, parseIntString } from './numbers';
import {
  Kwargs, MA, PyBuiltin, PyDict, PyList, PyModule, PyTuple, PyValue, Runtime,
  andThen, dictSet, exceptionType, typeName, typeOf,
} from './values';

export const JSONDecodeError = defineException('JSONDecodeError', ValueError);

// ── dumps ───────────────────────────────────────────────────────────────────

interface EncodeOptions {
  indent: string | null;
  itemSep: string;
  keySep: string;
  sortKeys: boolean;
  ensureAscii: boolean;
  fallback: PyValue | null;
}

function encodeString(s: string, ensureAscii: boolean): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (c < 0x20 || (ensureAscii && c > 0x7e)) {
      // Characters beyond the BMP are written as a surrogate pair, like CPython.
      for (let i = 0; i < ch.length; i++) out += '\\u' + ch.charCodeAt(i).toString(16).padStart(4, '0');
    } else out += ch;
  }
  return out + '"';
}

function encodeKey(key: PyValue): string {
  if (typeof key === 'string') return key;
  if (typeof key === 'boolean') return key ? 'true' : 'false';
  if (key === null) return 'null';
  if (typeof key === 'number' || typeof key === 'bigint') return key.toString();
  if (key instanceof PyFloat) return floatRepr(key.v);
  throw new TypeError(`keys must be str, int, float, bool or None, not ${typeName(key)}`);
}

/** Runs `fn` over `items` in order, staying synchronous unless a call waits. */
function mapSeq(items: PyValue[], fn: (item: PyValue, index: number) => MA<string>): MA<string[]> {
  const out: string[] = [];
  const step = (i: number): MA<string[]> => {
    for (; i < items.length; i++) {
      const r = fn(items[i], i);
      if (r instanceof Promise) {
        const at = i;
        return r.then((text) => {
          out.push(text);
          return step(at + 1);
        });
      }
      out.push(r);
    }
    return out;
  };
  return step(0);
}

function encode(rt: Runtime, value: PyValue, options: EncodeOptions, depth: number, seen: Set<object>): MA<string> {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return encodeString(value, options.ensureAscii);
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  if (value instanceof PyFloat) {
    const x = value.v;
    return Number.isNaN(x) ? 'NaN' : x === Infinity ? 'Infinity' : x === -Infinity ? '-Infinity' : floatRepr(x);
  }

  if (value instanceof PyList || value instanceof PyTuple || value instanceof PyDict) {
    if (seen.has(value)) throw new ValueError('Circular reference detected');
    seen.add(value);
    const { indent } = options;
    const open = indent === null ? '' : '\n' + indent.repeat(depth + 1);
    const close = indent === null ? '' : '\n' + indent.repeat(depth);
    const join = (parts: string[], brackets: string): string => {
      seen.delete(value);
      if (parts.length === 0) return brackets;
      const text = brackets[0] + open + parts.join(options.itemSep + open) + close + brackets[1];
      rt.checkString(text.length);
      return text;
    };
    if (value instanceof PyDict) {
      let entries = Array.from(value.map.values(), ([k, v]): [string, PyValue] => [encodeKey(k), v]);
      if (options.sortKeys) entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return andThen(
        mapSeq(entries.map((e) => e[1]), (v, i) =>
          andThen(encode(rt, v, options, depth + 1, seen), (text) =>
            encodeString(entries[i][0], options.ensureAscii) + options.keySep + text)),
        (parts) => join(parts, '{}'),
      );
    }
    return andThen(
      mapSeq(value.items, (v) => encode(rt, v, options, depth + 1, seen)),
      (parts) => join(parts, '[]'),
    );
  }

  if (options.fallback !== null) {
    return andThen(rt.call(options.fallback, [value]), (replacement) => encode(rt, replacement, options, depth, seen));
  }
  throw new TypeError(`Object of type ${typeOf(value).name} is not JSON serializable`);
}

function dumps(rt: Runtime, args: PyValue[], kwargs: Kwargs): MA<PyValue> {
  if (args.length !== 1) throw new TypeError(`dumps() takes exactly 1 positional argument (${args.length} given)`);
  const get = (name: string): PyValue | undefined => kwargs?.get(name);
  for (const key of kwargs?.keys() ?? []) {
    if (!['indent', 'sort_keys', 'default', 'ensure_ascii', 'separators', 'allow_nan'].includes(key)) {
      throw new TypeError(`dumps() got an unexpected keyword argument '${key}'`);
    }
  }
  const indentArg = get('indent');
  let indent: string | null = null;
  if (typeof indentArg === 'number') indent = ' '.repeat(Math.max(0, indentArg));
  else if (typeof indentArg === 'string') indent = indentArg;
  else if (indentArg !== undefined && indentArg !== null) throw new TypeError('indent must be an int, a str or None');

  let itemSep = indent === null ? ', ' : ',';
  let keySep = ': ';
  const separators = get('separators');
  if (separators instanceof PyTuple || separators instanceof PyList) {
    if (separators.items.length !== 2 || typeof separators.items[0] !== 'string' || typeof separators.items[1] !== 'string') {
      throw new TypeError('separators must be a pair of strings');
    }
    [itemSep, keySep] = separators.items as [string, string];
  }
  const fallback = get('default') ?? null;
  const options: EncodeOptions = {
    indent, itemSep, keySep,
    sortKeys: get('sort_keys') === true,
    ensureAscii: get('ensure_ascii') !== false,
    fallback,
  };
  return encode(rt, args[0], options, 0, new Set());
}

// ── loads ───────────────────────────────────────────────────────────────────

class Parser {
  pos = 0;
  constructor(private readonly text: string) {}

  fail(message: string, at: number = this.pos): never {
    const before = this.text.slice(0, at);
    const line = before.split('\n').length;
    const column = at - before.lastIndexOf('\n');
    throw new JSONDecodeError(`${message}: line ${line} column ${column} (char ${at})`);
  }

  skipSpace(): void {
    while (this.pos < this.text.length && ' \t\n\r'.includes(this.text[this.pos])) this.pos++;
  }

  parseDocument(): PyValue {
    this.skipSpace();
    const value = this.parseValue();
    this.skipSpace();
    if (this.pos < this.text.length) this.fail('Extra data');
    return value;
  }

  parseValue(): PyValue {
    const t = this.text;
    const c = t[this.pos];
    if (c === '{') return this.parseObject();
    if (c === '[') return this.parseArray();
    if (c === '"') return this.parseString();
    if ((c === '-' && t[this.pos + 1] !== 'I') || (c >= '0' && c <= '9')) return this.parseNumber();
    for (const [word, value] of [['true', true], ['false', false], ['null', null], ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity]] as const) {
      if (t.startsWith(word, this.pos)) {
        this.pos += word.length;
        return typeof value === 'number' ? new PyFloat(value) : value;
      }
    }
    this.fail('Expecting value');
  }

  parseObject(): PyValue {
    const t = this.text;
    const dict = new PyDict();
    this.pos++;
    this.skipSpace();
    if (t[this.pos] === '}') {
      this.pos++;
      return dict;
    }
    for (;;) {
      this.skipSpace();
      if (t[this.pos] !== '"') this.fail('Expecting property name enclosed in double quotes');
      const key = this.parseString();
      this.skipSpace();
      if (t[this.pos] !== ':') this.fail("Expecting ':' delimiter");
      this.pos++;
      this.skipSpace();
      dictSet(dict, key, this.parseValue());
      this.skipSpace();
      if (t[this.pos] === ',') {
        const comma = this.pos++;
        this.skipSpace();
        if (t[this.pos] === '}') this.fail('Illegal trailing comma before end of object', comma);
        continue;
      }
      if (t[this.pos] === '}') {
        this.pos++;
        return dict;
      }
      this.fail("Expecting ',' delimiter");
    }
  }

  parseArray(): PyValue {
    const t = this.text;
    const items: PyValue[] = [];
    this.pos++;
    this.skipSpace();
    if (t[this.pos] === ']') {
      this.pos++;
      return new PyList(items);
    }
    for (;;) {
      this.skipSpace();
      items.push(this.parseValue());
      this.skipSpace();
      if (t[this.pos] === ',') {
        const comma = this.pos++;
        this.skipSpace();
        if (t[this.pos] === ']') this.fail('Illegal trailing comma before end of array', comma);
        continue;
      }
      if (t[this.pos] === ']') {
        this.pos++;
        return new PyList(items);
      }
      this.fail("Expecting ',' delimiter");
    }
  }

  parseString(): string {
    const t = this.text;
    const start = this.pos;
    this.pos++;
    let out = '';
    for (;;) {
      if (this.pos >= t.length) this.fail('Unterminated string starting at', start);
      const c = t[this.pos++];
      if (c === '"') return out;
      if (c === '\\') {
        const e = t[this.pos++];
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            const hex = t.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('Invalid \\uXXXX escape', this.pos - 1);
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 4;
            break;
          }
          default:
            this.fail('Invalid \\escape', this.pos - 2);
        }
      } else if (c < ' ') {
        this.fail('Invalid control character at', this.pos - 1);
      } else {
        out += c;
      }
    }
  }

  parseNumber(): PyValue {
    const m = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(this.text.slice(this.pos));
    if (!m) this.fail('Expecting value');
    this.pos += m[0].length;
    if (m[1] === undefined && m[2] === undefined) return parseIntString(m[0], 10)!;
    return new PyFloat(Number(m[0]));
  }
}

function loads(_rt: Runtime, args: PyValue[], kwargs: Kwargs): PyValue {
  if (args.length !== 1) throw new TypeError(`loads() takes exactly 1 positional argument (${args.length} given)`);
  if (kwargs !== null && kwargs.size > 0) {
    throw new TypeError(`loads() got an unexpected keyword argument '${kwargs.keys().next().value}'`);
  }
  const text = args[0];
  if (typeof text !== 'string') {
    throw new TypeError(`the JSON object must be str, bytes or bytearray, not ${typeName(text)}`);
  }
  return new Parser(text).parseDocument();
}

export const json: PyModule = new PyModule('json', new Map<string, PyValue>([
  ['dumps', new PyBuiltin('dumps', dumps, true)],
  ['loads', new PyBuiltin('loads', loads, true)],
  ['JSONDecodeError', exceptionType(JSONDecodeError)],
]));
