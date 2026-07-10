/**
 * The whitelisted `re` module, backed by JavaScript RegExp.
 *
 * Python patterns are translated to the JS dialect before compilation:
 * `(?P<name>...)` → `(?<name>...)`, `(?P=name)` → `\k<name>`, `(?#...)`
 * comments are stripped, global inline flags like `(?i)` are lifted onto the
 * RegExp, and `\A` / `\Z` become lookarounds that anchor to the string ends.
 * Known divergences from CPython (documented in the README): `\d`/`\w`/`\s`
 * are ASCII-only like JS, `$` does not match before a trailing newline, and
 * `re.VERBOSE`, scoped inline flags, callable replacements, and conditional
 * groups are not supported (they raise with a targeted message).
 *
 * Pure computation, no state: the module object is a process-wide singleton.
 */

import {
  PyValue,
  PyBuiltin,
  PyModule,
  pyNumber,
  pyString,
  pyNone,
  pyList,
  pyTuple,
  pyIterator,
  pyDict,
  dictSet,
  isNumber,
  isString,
  isNone,
  pyTypeName,
} from './values';
import { extractKwargs } from './builtins';
import { TypeError, ValueError, IndexError } from './errors';

// Python flag values (module constants).
const FLAG_I = 2;    // IGNORECASE
const FLAG_M = 8;    // MULTILINE
const FLAG_S = 16;   // DOTALL
const FLAG_X = 64;   // VERBOSE
const FLAG_A = 256;  // ASCII — a no-op: JS \d/\w/\s are ASCII already

function reError(message: string): never {
  throw new ValueError(message, 0, 0);
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

function method(name: string, fn: PyBuiltin['fn'], acceptsKwargs = false): PyBuiltin {
  return acceptsKwargs ? { type: 'builtin', name, fn, acceptsKwargs } : { type: 'builtin', name, fn };
}

type ExecMatch = RegExpExecArray & {
  indices?: Array<[number, number] | undefined> & { groups?: Record<string, [number, number] | undefined> };
};

// ── Match objects ────────────────────────────────────────────────────────────

/** Build a Python-facing match object: a builtin-typed value whose attrs
 *  carry the group/span accessors. Truthy, so `if m:` works; a failed match
 *  is represented by None. */
function makeMatch(m: ExecMatch): PyValue {
  const groupCount = m.length - 1;
  const named = m.groups ?? {};

  const resolveGroup = (arg: PyValue): number | string => {
    if (isNumber(arg)) {
      if (!Number.isInteger(arg.value) || arg.value < 0 || arg.value > groupCount) throw new IndexError('no such group', 0, 0);
      return arg.value;
    }
    if (isString(arg)) {
      if (!Object.prototype.hasOwnProperty.call(named, arg.value)) throw new IndexError('no such group', 0, 0);
      return arg.value;
    }
    throw new IndexError('no such group', 0, 0);
  };
  const groupText = (g: number | string): string | undefined =>
    typeof g === 'number' ? m[g] : named[g];
  const groupSpan = (g: number | string): [number, number] | undefined =>
    typeof g === 'number' ? m.indices?.[g] : m.indices?.groups?.[g];

  const attrs = new Map<string, PyValue>();
  attrs.set('group', method('re.Match.group', (...args: PyValue[]) => {
    if (args.length === 0) return pyString(m[0]);
    const pick = (arg: PyValue): PyValue => {
      const text = groupText(resolveGroup(arg));
      return text === undefined ? pyNone() : pyString(text);
    };
    return args.length === 1 ? pick(args[0]) : pyTuple(args.map(pick));
  }));
  attrs.set('groups', method('re.Match.groups', (defaultVal?: PyValue) => {
    const fallback = defaultVal ?? pyNone();
    const out: PyValue[] = [];
    for (let g = 1; g <= groupCount; g++) out.push(m[g] === undefined ? fallback : pyString(m[g]));
    return pyTuple(out);
  }));
  attrs.set('groupdict', method('re.Match.groupdict', (defaultVal?: PyValue) => {
    const fallback = defaultVal ?? pyNone();
    const dict = pyDict();
    for (const name of Object.keys(named)) {
      dictSet(dict, pyString(name), named[name] === undefined ? fallback : pyString(named[name]!));
    }
    return dict;
  }));
  const spanOf = (arg?: PyValue): [number, number] => {
    const g = arg === undefined ? 0 : resolveGroup(arg);
    return groupSpan(g) ?? [-1, -1];
  };
  attrs.set('start', method('re.Match.start', (arg?: PyValue) => pyNumber(spanOf(arg)[0])));
  attrs.set('end', method('re.Match.end', (arg?: PyValue) => pyNumber(spanOf(arg)[1])));
  attrs.set('span', method('re.Match.span', (arg?: PyValue) => {
    const [s, e] = spanOf(arg);
    return pyTuple([pyNumber(s), pyNumber(e)]);
  }));

  return {
    type: 'builtin',
    name: 're.Match',
    attrs,
    fn: () => { throw new TypeError("'re.Match' object is not callable", 0, 0); },
  };
}

// ── Core operations (shared by module functions and Pattern methods) ────────

function opSearch(regex: RegExp, subject: string): PyValue {
  const m = withFlags(regex, '').exec(subject) as ExecMatch | null;
  return m ? makeMatch(m) : pyNone();
}

function opMatch(regex: RegExp, subject: string): PyValue {
  const sticky = withFlags(regex, 'y');
  sticky.lastIndex = 0;
  const m = sticky.exec(subject) as ExecMatch | null;
  return m ? makeMatch(m) : pyNone();
}

function opFullmatch(regex: RegExp, subject: string): PyValue {
  // (?:...) preserves group numbering; sticky anchors the start, $ the end.
  const anchored = new RegExp(`(?:${regex.source})$`, regex.flags + 'y');
  anchored.lastIndex = 0;
  const m = anchored.exec(subject) as ExecMatch | null;
  return m ? makeMatch(m) : pyNone();
}

function opFindall(regex: RegExp, subject: string): PyValue {
  const results: PyValue[] = [];
  for (const m of subject.matchAll(withFlags(regex, 'g'))) {
    const groupCount = m.length - 1;
    if (groupCount === 0) results.push(pyString(m[0]));
    else if (groupCount === 1) results.push(pyString(m[1] ?? ''));
    else results.push(pyTuple(m.slice(1).map(v => pyString(v ?? ''))));
  }
  return pyList(results);
}

function opFinditer(regex: RegExp, subject: string): PyValue {
  const matches: PyValue[] = [];
  for (const m of subject.matchAll(withFlags(regex, 'g'))) {
    matches.push(makeMatch(m as ExecMatch));
  }
  return pyIterator(matches);
}

/** Expand a Python replacement template (`\1`, `\g<name>`, `\n`, `\\`). */
function expandTemplate(template: string, m: ExecMatch): string {
  const named = m.groups ?? {};
  const groupValue = (g: number | string): string => {
    const v = typeof g === 'number' ? m[g] : named[g];
    if (typeof g === 'number' && (g < 0 || g >= m.length)) reError(`invalid group reference ${g} in replacement`);
    if (typeof g === 'string' && !Object.prototype.hasOwnProperty.call(named, g)) reError(`unknown group name '${g}' in replacement`);
    if (v === undefined) reError('unmatched group');
    return v;
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

function opSub(regex: RegExp, repl: PyValue, subject: string, count: number): { result: string; n: number } {
  if (!isString(repl)) {
    throw new TypeError(
      "re.sub replacement must be a string in this sandbox — callable replacements are not supported; use finditer() and build the string yourself",
      0, 0
    );
  }
  let out = '';
  let last = 0;
  let n = 0;
  for (const m of subject.matchAll(withFlags(regex, 'g'))) {
    if (count > 0 && n >= count) break;
    out += subject.slice(last, m.index!) + expandTemplate(repl.value, m as ExecMatch);
    last = m.index! + m[0].length;
    n++;
  }
  out += subject.slice(last);
  return { result: out, n };
}

function opSplit(regex: RegExp, subject: string, maxsplit: number): PyValue {
  const parts: PyValue[] = [];
  let last = 0;
  let n = 0;
  for (const m of subject.matchAll(withFlags(regex, 'g'))) {
    if (maxsplit > 0 && n >= maxsplit) break;
    parts.push(pyString(subject.slice(last, m.index!)));
    // Like CPython, captured groups participate in the result.
    for (let g = 1; g < m.length; g++) parts.push(m[g] === undefined ? pyNone() : pyString(m[g]));
    last = m.index! + m[0].length;
    n++;
  }
  parts.push(pyString(subject.slice(last)));
  return pyList(parts);
}

// ── Argument plumbing ────────────────────────────────────────────────────────

function strArg(value: PyValue | undefined, fnName: string, argName: string): string {
  if (value !== undefined && isString(value)) return value.value;
  throw new TypeError(`${fnName}() ${argName} must be a str, not ${value === undefined ? 'NoneType' : pyTypeName(value)}`, 0, 0);
}

function intArg(value: PyValue | undefined, fallback: number): number {
  if (value === undefined || isNone(value)) return fallback;
  if (isNumber(value)) return value.value;
  throw new TypeError(`expected int, got ${pyTypeName(value)}`, 0, 0);
}

/** First argument of the module-level functions: a pattern string or a
 *  compiled Pattern object. */
function regexFrom(value: PyValue | undefined, flags: number, fnName: string): RegExp {
  if (value !== undefined && isString(value)) return compilePattern(value.value, flags);
  const compiled = value && (value as any).__regex;
  if (compiled instanceof RegExp) {
    if (flags !== 0) reError('cannot process flags argument with a compiled pattern');
    return compiled;
  }
  throw new TypeError(`${fnName}() pattern must be a str or compiled pattern, not ${value === undefined ? 'NoneType' : pyTypeName(value)}`, 0, 0);
}

// ── Module assembly ──────────────────────────────────────────────────────────

function makePatternObject(regex: RegExp, patternSource: string): PyValue {
  const attrs = new Map<string, PyValue>();
  attrs.set('pattern', pyString(patternSource));
  attrs.set('search', method('re.Pattern.search', (s: PyValue) => opSearch(regex, strArg(s, 'search', 'string'))));
  attrs.set('match', method('re.Pattern.match', (s: PyValue) => opMatch(regex, strArg(s, 'match', 'string'))));
  attrs.set('fullmatch', method('re.Pattern.fullmatch', (s: PyValue) => opFullmatch(regex, strArg(s, 'fullmatch', 'string'))));
  attrs.set('findall', method('re.Pattern.findall', (s: PyValue) => opFindall(regex, strArg(s, 'findall', 'string'))));
  attrs.set('finditer', method('re.Pattern.finditer', (s: PyValue) => opFinditer(regex, strArg(s, 'finditer', 'string'))));
  attrs.set('sub', method('re.Pattern.sub', (...rawArgs: any[]) => {
    const { args, kwargs } = extractKwargs(rawArgs);
    const { result } = opSub(regex, args[0], strArg(args[1], 'sub', 'string'), intArg(args[2] ?? kwargs.count, 0));
    return pyString(result);
  }, true));
  attrs.set('subn', method('re.Pattern.subn', (...rawArgs: any[]) => {
    const { args, kwargs } = extractKwargs(rawArgs);
    const { result, n } = opSub(regex, args[0], strArg(args[1], 'subn', 'string'), intArg(args[2] ?? kwargs.count, 0));
    return pyTuple([pyString(result), pyNumber(n)]);
  }, true));
  attrs.set('split', method('re.Pattern.split', (...rawArgs: any[]) => {
    const { args, kwargs } = extractKwargs(rawArgs);
    return opSplit(regex, strArg(args[0], 'split', 'string'), intArg(args[1] ?? kwargs.maxsplit, 0));
  }, true));

  const obj: PyValue = {
    type: 'builtin',
    name: 're.Pattern',
    attrs,
    fn: () => { throw new TypeError("'re.Pattern' object is not callable", 0, 0); },
  };
  (obj as any).__regex = regex;
  return obj;
}

/** Module-level function that takes (pattern, string, flags=0). */
function patternStringFn(name: string, op: (regex: RegExp, subject: string) => PyValue): PyBuiltin {
  return method(`re.${name}`, (...rawArgs: any[]) => {
    const { args, kwargs } = extractKwargs(rawArgs);
    const flags = intArg(args[2] ?? kwargs.flags, 0);
    const regex = regexFrom(args[0], flags, name);
    return op(regex, strArg(args[1], name, 'string'));
  }, true);
}

function createReModule(): PyModule {
  const attrs = new Map<string, PyValue>([
    ['I', pyNumber(FLAG_I)],
    ['IGNORECASE', pyNumber(FLAG_I)],
    ['M', pyNumber(FLAG_M)],
    ['MULTILINE', pyNumber(FLAG_M)],
    ['S', pyNumber(FLAG_S)],
    ['DOTALL', pyNumber(FLAG_S)],
    ['X', pyNumber(FLAG_X)],
    ['VERBOSE', pyNumber(FLAG_X)],
    ['A', pyNumber(FLAG_A)],
    ['ASCII', pyNumber(FLAG_A)],

    ['search', patternStringFn('search', opSearch)],
    ['match', patternStringFn('match', opMatch)],
    ['fullmatch', patternStringFn('fullmatch', opFullmatch)],
    ['findall', patternStringFn('findall', opFindall)],
    ['finditer', patternStringFn('finditer', opFinditer)],
  ]);

  attrs.set('compile', method('re.compile', (...rawArgs: any[]) => {
    const { args, kwargs } = extractKwargs(rawArgs);
    const pattern = strArg(args[0], 'compile', 'pattern');
    const flags = intArg(args[1] ?? kwargs.flags, 0);
    return makePatternObject(compilePattern(pattern, flags), pattern);
  }, true));

  attrs.set('sub', method('re.sub', (...rawArgs: any[]) => {
    const { args, kwargs } = extractKwargs(rawArgs);
    const flags = intArg(args[4] ?? kwargs.flags, 0);
    const regex = regexFrom(args[0], flags, 'sub');
    const { result } = opSub(regex, args[1], strArg(args[2], 'sub', 'string'), intArg(args[3] ?? kwargs.count, 0));
    return pyString(result);
  }, true));

  attrs.set('subn', method('re.subn', (...rawArgs: any[]) => {
    const { args, kwargs } = extractKwargs(rawArgs);
    const flags = intArg(args[4] ?? kwargs.flags, 0);
    const regex = regexFrom(args[0], flags, 'subn');
    const { result, n } = opSub(regex, args[1], strArg(args[2], 'subn', 'string'), intArg(args[3] ?? kwargs.count, 0));
    return pyTuple([pyString(result), pyNumber(n)]);
  }, true));

  attrs.set('split', method('re.split', (...rawArgs: any[]) => {
    const { args, kwargs } = extractKwargs(rawArgs);
    const flags = intArg(args[3] ?? kwargs.flags, 0);
    const regex = regexFrom(args[0], flags, 'split');
    return opSplit(regex, strArg(args[1], 'split', 'string'), intArg(args[2] ?? kwargs.maxsplit, 0));
  }, true));

  attrs.set('escape', method('re.escape', (s: PyValue) => {
    // CPython 3.7+ escapes exactly the special characters (its _special_chars_map).
    return pyString(strArg(s, 'escape', 'pattern').replace(/[()[\]{}?*+\-|^$\\.&~# \t\n\r\v\f]/g, ch => '\\' + ch));
  }));

  return { type: 'module', name: 're', attrs };
}

export const reModule: PyModule = createReModule();
