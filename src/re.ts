/**
 * The whitelisted `re` module, backed by JavaScript RegExp.
 *
 * Python patterns are translated to the JS dialect before compilation:
 * `(?P<name>...)` → `(?<name>...)`, `(?P=name)` → `\k<name>`, `(?#...)`
 * comments are stripped, global inline flags like `(?i)` are lifted onto the
 * RegExp, and `\A` / `\Z` become lookarounds that anchor to the string ends.
 * Known divergences from CPython (documented in the README): `\d`/`\w`/`\s`
 * are ASCII-only like JS, `$` does not match before a trailing newline, and
 * `re.VERBOSE`, scoped inline flags and conditional groups are not supported
 * (they raise with a targeted message).
 *
 * Pure computation, no state: the module object is a process-wide singleton.
 */

import { IndexError, TypeError, ValueError } from './errors';
import { mapCall } from './methods';
import {
  Kwargs, MA, NativeFn, PyBuiltin, PyDict, PyList, PyModule, PyObject, PyTuple, PyValue, Runtime, SeqIterator,
  dictSet, exceptionType, strRepr, andThen, typeName,
} from './values';

// Python flag values (module constants).
const FLAG_I = 2;    // IGNORECASE
const FLAG_M = 8;    // MULTILINE
const FLAG_S = 16;   // DOTALL
const FLAG_X = 64;   // VERBOSE
const FLAG_A = 256;  // ASCII — a no-op: JS \d/\w/\s are ASCII already

function reError(message: string): never {
  throw new ValueError(message);
}

/** Translate a Python pattern to JS RegExp source, lifting global inline
 *  flags. Throws ValueError on constructs the JS dialect can't express. */
function translatePattern(pattern: string): { source: string; inlineFlags: string } {
  let out = '';
  let inlineFlags = '';
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      const next = pattern[i + 1];
      if (next === undefined) reError('bad escape (end of pattern)');
      if (!inClass && next === 'A') { out += '(?<![\\s\\S])'; i++; continue; }
      if (!inClass && next === 'Z') { out += '(?![\\s\\S])'; i++; continue; }
      out += c + next;
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      out += c;
      continue;
    }
    if (c === '[') { inClass = true; out += c; continue; }
    if (c === '(' && pattern[i + 1] === '?') {
      const rest = pattern.slice(i);
      let m: RegExpMatchArray | null;
      if ((m = rest.match(/^\(\?P<([^>]+)>/))) { out += `(?<${m[1]}>`; i += m[0].length - 1; continue; }
      if ((m = rest.match(/^\(\?P=([A-Za-z_][A-Za-z0-9_]*)\)/))) { out += `\\k<${m[1]}>`; i += m[0].length - 1; continue; }
      if ((m = rest.match(/^\(\?#[^)]*\)/))) { i += m[0].length - 1; continue; }
      if ((m = rest.match(/^\(\?([aimsxL]+)\)/))) {
        if (m[1].includes('x')) reError('re.VERBOSE / (?x) patterns are not supported in this sandbox — remove the whitespace and comments from the pattern');
        if (m[1].includes('L')) reError('the (?L) locale flag is not supported in this sandbox');
        inlineFlags += m[1];
        i += m[0].length - 1;
        continue;
      }
      if (rest.match(/^\(\?[aimsxL-]*:/)) reError('scoped inline flags like (?i:...) are not supported in this sandbox — apply the flag to the whole pattern instead');
      if (rest.startsWith('(?(')) reError('conditional groups (?(id)...) are not supported in this sandbox');
      if (rest.startsWith('(?:') || rest.startsWith('(?=') || rest.startsWith('(?!') ||
          rest.startsWith('(?<=') || rest.startsWith('(?<!') || rest.match(/^\(\?<[A-Za-z_]/)) {
        out += '(?';
        i++;
        continue;
      }
      reError(`unsupported regex construct '${rest.slice(0, 4)}' at position ${i}`);
    }
    out += c;
  }
  return { source: out, inlineFlags };
}

function compilePattern(pattern: string, pyFlags: number): RegExp {
  if (pyFlags & FLAG_X) reError('re.VERBOSE (re.X) is not supported in this sandbox — remove the whitespace and comments from the pattern');
  const { source, inlineFlags } = translatePattern(pattern);
  // 'd' provides match indices for Match.start()/end()/span().
  let flags = 'd';
  if (pyFlags & FLAG_I || inlineFlags.includes('i')) flags += 'i';
  if (pyFlags & FLAG_M || inlineFlags.includes('m')) flags += 'm';
  if (pyFlags & FLAG_S || inlineFlags.includes('s')) flags += 's';
  try {
    return new RegExp(source, flags);
  } catch (e) {
    reError(`invalid regular expression: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function withFlags(regex: RegExp, extra: string): RegExp {
  return new RegExp(regex.source, regex.flags + extra);
}

function method(name: string, fn: NativeFn, kw = false): PyBuiltin {
  return new PyBuiltin(name, fn, kw);
}

type ExecMatch = RegExpExecArray & {
  indices?: Array<[number, number] | undefined> & { groups?: Record<string, [number, number] | undefined> };
};

// ── Match objects ────────────────────────────────────────────────────────────

/** A successful match; a failed match is None, so `if m:` works. */
class PyMatch extends PyObject {
  readonly typeName = 're.Match';

  constructor(private readonly m: ExecMatch) {
    super();
  }

  private get named(): Record<string, string | undefined> {
    return this.m.groups ?? {};
  }

  private resolveGroup(arg: PyValue): number | string {
    if (typeof arg === 'number' && arg >= 0 && arg < this.m.length) return arg;
    if (typeof arg === 'string' && Object.prototype.hasOwnProperty.call(this.named, arg)) return arg;
    throw new IndexError('no such group');
  }

  private text(g: number | string): PyValue {
    const value = typeof g === 'number' ? this.m[g] : this.named[g];
    return value === undefined ? null : value;
  }

  private span(arg: PyValue | undefined): [number, number] {
    const g = arg === undefined ? 0 : this.resolveGroup(arg);
    const span = typeof g === 'number' ? this.m.indices?.[g] : this.m.indices?.groups?.[g];
    return span ?? [-1, -1];
  }

  repr(): string {
    const [start, end] = this.span(undefined);
    return `<re.Match object; span=(${start}, ${end}), match=${strRepr(this.m[0])}>`;
  }

  getAttr(name: string): PyValue | undefined {
    const m = this.m;
    switch (name) {
      case 'group':
        return method('group', (_rt, args) => {
          if (args.length === 0) return m[0];
          const pick = (arg: PyValue) => this.text(this.resolveGroup(arg));
          return args.length === 1 ? pick(args[0]) : new PyTuple(args.map(pick));
        });
      case 'groups':
        return method('groups', (_rt, args) => {
          const fallback = args[0] ?? null;
          const out: PyValue[] = [];
          for (let g = 1; g < m.length; g++) out.push(m[g] === undefined ? fallback : m[g]);
          return new PyTuple(out);
        });
      case 'groupdict':
        return method('groupdict', (_rt, args) => {
          const fallback = args[0] ?? null;
          const dict = new PyDict();
          for (const key of Object.keys(this.named)) dictSet(dict, key, this.named[key] ?? fallback);
          return dict;
        });
      case 'start': return method('start', (_rt, args) => this.span(args[0])[0]);
      case 'end': return method('end', (_rt, args) => this.span(args[0])[1]);
      case 'span': return method('span', (_rt, args) => new PyTuple(this.span(args[0])));
      case 'string': return m.input;
      default: return undefined;
    }
  }

  /** `m[0]`, `m["name"]`: same as group(). */
  getItem(arg: PyValue): PyValue {
    return this.text(this.resolveGroup(arg));
  }
}

function matchOrNone(m: RegExpExecArray | null): PyValue {
  return m ? new PyMatch(m as ExecMatch) : null;
}

// ── Core operations (shared by module functions and Pattern methods) ────────

function opSearch(regex: RegExp, subject: string): PyValue {
  return matchOrNone(withFlags(regex, '').exec(subject));
}

function opMatch(regex: RegExp, subject: string): PyValue {
  const sticky = withFlags(regex, 'y');
  sticky.lastIndex = 0;
  return matchOrNone(sticky.exec(subject));
}

function opFullmatch(regex: RegExp, subject: string): PyValue {
  // (?:...) preserves group numbering; sticky anchors the start, $ the end.
  const anchored = new RegExp(`(?:${regex.source})$`, regex.flags + 'y');
  anchored.lastIndex = 0;
  return matchOrNone(anchored.exec(subject));
}

function opFindall(regex: RegExp, subject: string): PyValue {
  const results: PyValue[] = [];
  for (const m of subject.matchAll(withFlags(regex, 'g'))) {
    const groupCount = m.length - 1;
    if (groupCount === 0) results.push(m[0]);
    else if (groupCount === 1) results.push(m[1] ?? '');
    else results.push(new PyTuple(m.slice(1).map((v) => v ?? '')));
  }
  return new PyList(results);
}

function opFinditer(regex: RegExp, subject: string): PyValue {
  const matches: PyValue[] = [];
  for (const m of subject.matchAll(withFlags(regex, 'g'))) matches.push(new PyMatch(m as ExecMatch));
  return new SeqIterator(matches, 'callable_iterator');
}

/** Expand a Python replacement template (`\1`, `\g<name>`, `\n`, `\\`). */
function expandTemplate(template: string, m: ExecMatch): string {
  const named = m.groups ?? {};
  const groupValue = (g: number | string): string => {
    const v = typeof g === 'number' ? m[g] : named[g];
    if (typeof g === 'number' && (g < 0 || g >= m.length)) reError(`invalid group reference ${g} in replacement`);
    if (typeof g === 'string' && !Object.prototype.hasOwnProperty.call(named, g)) reError(`unknown group name '${g}' in replacement`);
    return v ?? '';
  };
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (c !== '\\') { out += c; continue; }
    const next = template[i + 1];
    if (next === undefined) reError('bad escape (end of pattern) in replacement');
    if (next >= '0' && next <= '9') {
      let digits = next;
      if (template[i + 2] >= '0' && template[i + 2] <= '9') digits += template[i + 2];
      out += groupValue(parseInt(digits, 10));
      i += digits.length;
      continue;
    }
    if (next === 'g') {
      const rest = template.slice(i + 2);
      const gm = rest.match(/^<([^>]+)>/);
      if (!gm) reError(`missing < after \\g in replacement`);
      const ref = gm[1];
      out += groupValue(/^\d+$/.test(ref) ? parseInt(ref, 10) : ref);
      i += 1 + gm[0].length;
      continue;
    }
    switch (next) {
      case '\\': out += '\\'; break;
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      default: reError(`bad escape \\${next} in replacement`);
    }
    i++;
  }
  return out;
}

/** `repl` is a template string, or a function called with each match. */
function opSub(rt: Runtime, regex: RegExp, repl: PyValue, subject: string, count: number): MA<{ result: string; n: number }> {
  const matches: ExecMatch[] = [];
  for (const m of subject.matchAll(withFlags(regex, 'g'))) {
    if (count > 0 && matches.length >= count) break;
    matches.push(m as ExecMatch);
  }
  const build = (replacements: string[]) => {
    let out = '';
    let last = 0;
    matches.forEach((m, i) => {
      out += subject.slice(last, m.index) + replacements[i];
      last = m.index + m[0].length;
    });
    out += subject.slice(last);
    rt.checkString(out.length);
    return { result: out, n: matches.length };
  };
  if (typeof repl === 'string') return build(matches.map((m) => expandTemplate(repl, m)));
  return andThen(mapCall(rt, repl, matches.map((m) => new PyMatch(m))), (values) =>
    build(values.map((v) => {
      if (typeof v !== 'string') throw new TypeError(`expected str instance, ${typeName(v)} found`);
      return v;
    })));
}

function opSplit(regex: RegExp, subject: string, maxsplit: number): PyValue {
  const parts: PyValue[] = [];
  let last = 0;
  let n = 0;
  for (const m of subject.matchAll(withFlags(regex, 'g'))) {
    if (maxsplit > 0 && n >= maxsplit) break;
    parts.push(subject.slice(last, m.index));
    // Like CPython, captured groups participate in the result.
    for (let g = 1; g < m.length; g++) parts.push(m[g] === undefined ? null : m[g]);
    last = m.index + m[0].length;
    n++;
  }
  parts.push(subject.slice(last));
  return new PyList(parts);
}

// ── Argument plumbing ────────────────────────────────────────────────────────

function strArg(value: PyValue | undefined, fnName: string, argName: string): string {
  if (typeof value === 'string') return value;
  throw new TypeError(`${fnName}() ${argName} must be a str, not ${value === undefined ? 'NoneType' : typeName(value)}`);
}

function intArg(value: PyValue | undefined, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number') return value;
  throw new TypeError(`expected int, got ${typeName(value)}`);
}

function pick(args: PyValue[], kwargs: Kwargs, index: number, name: string): PyValue | undefined {
  return args[index] ?? kwargs?.get(name);
}

// ── Pattern objects ──────────────────────────────────────────────────────────

class PyPattern extends PyObject {
  readonly typeName = 're.Pattern';

  constructor(readonly regex: RegExp, private readonly source: string) {
    super();
  }

  repr(): string {
    return `re.compile(${strRepr(this.source)})`;
  }

  getAttr(name: string): PyValue | undefined {
    const { regex } = this;
    const onString = (op: (regex: RegExp, subject: string) => PyValue) =>
      method(name, (_rt, args) => op(regex, strArg(args[0], name, 'string')));
    switch (name) {
      case 'pattern': return this.source;
      case 'search': return onString(opSearch);
      case 'match': return onString(opMatch);
      case 'fullmatch': return onString(opFullmatch);
      case 'findall': return onString(opFindall);
      case 'finditer': return onString(opFinditer);
      case 'sub':
        return method('sub', (rt, args, kwargs) =>
          andThen(opSub(rt, regex, args[0], strArg(args[1], 'sub', 'string'), intArg(pick(args, kwargs, 2, 'count'), 0)),
            (r) => r.result), true);
      case 'subn':
        return method('subn', (rt, args, kwargs) =>
          andThen(opSub(rt, regex, args[0], strArg(args[1], 'subn', 'string'), intArg(pick(args, kwargs, 2, 'count'), 0)),
            (r) => new PyTuple([r.result, r.n])), true);
      case 'split':
        return method('split', (_rt, args, kwargs) =>
          opSplit(regex, strArg(args[0], 'split', 'string'), intArg(pick(args, kwargs, 1, 'maxsplit'), 0)), true);
      default: return undefined;
    }
  }
}

/** First argument of the module-level functions: a pattern string or a
 *  compiled Pattern object. */
function regexFrom(value: PyValue | undefined, flags: number, fnName: string): RegExp {
  if (typeof value === 'string') return compilePattern(value, flags);
  if (value instanceof PyPattern) {
    if (flags !== 0) reError('cannot process flags argument with a compiled pattern');
    return value.regex;
  }
  throw new TypeError(`${fnName}() pattern must be a str or compiled pattern, not ${value === undefined ? 'NoneType' : typeName(value)}`);
}

// ── Module assembly ──────────────────────────────────────────────────────────

/** Module-level function that takes (pattern, string, flags=0). */
function patternStringFn(name: string, op: (regex: RegExp, subject: string) => PyValue): PyBuiltin {
  return method(name, (_rt, args, kwargs) => {
    const regex = regexFrom(args[0], intArg(pick(args, kwargs, 2, 'flags'), 0), name);
    return op(regex, strArg(args[1], name, 'string'));
  }, true);
}

function createReModule(): PyModule {
  const attrs = new Map<string, PyValue>([
    ['I', FLAG_I],
    ['IGNORECASE', FLAG_I],
    ['M', FLAG_M],
    ['MULTILINE', FLAG_M],
    ['S', FLAG_S],
    ['DOTALL', FLAG_S],
    ['X', FLAG_X],
    ['VERBOSE', FLAG_X],
    ['A', FLAG_A],
    ['ASCII', FLAG_A],
    // Invalid patterns raise ValueError here, so `except re.error` catches them.
    ['error', exceptionType(ValueError)],

    ['search', patternStringFn('search', opSearch)],
    ['match', patternStringFn('match', opMatch)],
    ['fullmatch', patternStringFn('fullmatch', opFullmatch)],
    ['findall', patternStringFn('findall', opFindall)],
    ['finditer', patternStringFn('finditer', opFinditer)],
  ]);

  attrs.set('compile', method('compile', (_rt, args, kwargs) => {
    const pattern = strArg(args[0], 'compile', 'pattern');
    return new PyPattern(compilePattern(pattern, intArg(pick(args, kwargs, 1, 'flags'), 0)), pattern);
  }, true));

  const sub = (name: 'sub' | 'subn') => method(name, (rt, args, kwargs) => {
    const regex = regexFrom(args[0], intArg(pick(args, kwargs, 4, 'flags'), 0), name);
    const done = opSub(rt, regex, args[1], strArg(args[2], name, 'string'), intArg(pick(args, kwargs, 3, 'count'), 0));
    return andThen(done, (r): PyValue => (name === 'sub' ? r.result : new PyTuple([r.result, r.n])));
  }, true);
  attrs.set('sub', sub('sub'));
  attrs.set('subn', sub('subn'));

  attrs.set('split', method('split', (_rt, args, kwargs) => {
    const regex = regexFrom(args[0], intArg(pick(args, kwargs, 3, 'flags'), 0), 'split');
    return opSplit(regex, strArg(args[1], 'split', 'string'), intArg(pick(args, kwargs, 2, 'maxsplit'), 0));
  }, true));

  attrs.set('escape', method('escape', (_rt, args) => {
    // CPython 3.7+ escapes exactly the special characters (its _special_chars_map).
    return strArg(args[0], 'escape', 'pattern').replace(/[()[\]{}?*+\-|^$\\.&~# \t\n\r\v\f]/g, (ch) => '\\' + ch);
  }));

  return new PyModule('re', attrs);
}

export const reModule: PyModule = createReModule();
