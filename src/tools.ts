/**
 * Host tools: the functions a script may call. This file owns the public
 * `tools` shape, how a Python call's arguments reach a JS handler, and the
 * signature each tool shows in generateToolsPrompt.
 *
 * Three forms are accepted:
 *   - a plain function: `fetch: (quarter) => ...`, arguments by position,
 *     keywords matched to parameter names read from the function source;
 *   - a spec: `fetch: { params: { quarter: 'str' }, handler: ({ quarter }) => ... }`,
 *     the handler always gets one object;
 *   - the 0.3 array of ToolDefinition, kept so old hosts keep working.
 */

import { TypeError } from './errors';
import { jsToValue, pyRepr, setOwn } from './values';

// ── Public types ────────────────────────────────────────────────────────────

/** Python type names a parameter can declare; shown to the model as-is. */
export type ParamType = 'str' | 'int' | 'float' | 'bool' | 'list' | 'dict' | 'datetime' | 'any';

/** A parameter: a type, `'int?'` for optional, or the long form with a
 *  description and a default. A default makes the parameter optional. */
export type ParamSpec = ParamType | `${ParamType}?` | {
  type?: ParamType;
  description?: string;
  /** A JS value, applied when the script leaves the argument out. */
  default?: unknown;
};

type JsOf<T> = T extends 'str' ? string
  : T extends 'int' | 'float' ? number
  : T extends 'bool' ? boolean
  : T extends 'list' ? any[]
  : T extends 'dict' ? Record<string, any>
  : T extends 'datetime' ? string
  : any;

type ParamJs<P> = P extends `${infer T}?` ? JsOf<T> | undefined
  : P extends string ? JsOf<P>
  : P extends { type: infer T } ? JsOf<T>
  : any;

/** The object a spec'd handler receives, typed from its `params`. */
export type ArgsOf<P> = { [K in keyof P]: ParamJs<P[K]> };

export type ToolFunction = (...args: any[]) => any;

export interface ToolSpec<P extends Record<string, ParamSpec> = Record<string, ParamSpec>> {
  description?: string;
  params?: P;
  handler: (args: ArgsOf<P>) => any;
  /** Section heading used by generateToolsPrompt to group large tool sets. */
  group?: string;
}

/** The `tools` option: tool name → plain function or spec. */
export type Tools = Record<string, ToolFunction | ToolSpec<any>>;

/** Types a spec's handler from its `params`:
 *  `tool({ params: { n: 'int' }, handler: ({ n }) => n + 1 })`. */
export function tool<const P extends Record<string, ParamSpec>>(spec: ToolSpec<P>): ToolSpec<P> {
  return spec;
}

/** The 0.3 form. `parameters` is prompt metadata only; the handler gets the
 *  positional arguments followed by one object holding any keywords. */
export interface ToolParameter {
  name: string;
  /** Python type shown in the signature, e.g. 'str', 'int', 'list[dict]'. */
  type?: string;
  /** Rendered verbatim as the default value, e.g. '"USD"' or 'None'. */
  default?: string;
  description?: string;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  handler: (...args: any[]) => any;
  parameters?: ToolParameter[];
  group?: string;
}

// ── Normalized form ─────────────────────────────────────────────────────────

export interface ParamInfo {
  name: string;
  type: string | null;
  description: string | null;
  /** Python source for the signature; null when there is no default. */
  defaultText: string | null;
  hasDefault: boolean;
  default: unknown;
  optional: boolean;
}

export interface NormalizedTool {
  name: string;
  description: string | null;
  group: string | null;
  params: ParamInfo[];
  /** 'object': one args object. 'positional': by position, keywords matched
   *  to `params` names. 'legacy': positional plus a trailing keywords object. */
  mode: 'object' | 'positional' | 'legacy';
  fn: (...args: any[]) => any;
}

function paramInfo(name: string, spec: ParamSpec): ParamInfo {
  if (typeof spec === 'string') {
    const optional = spec.endsWith('?');
    return {
      name, type: optional ? spec.slice(0, -1) : spec, description: null,
      defaultText: optional ? 'None' : null, hasDefault: false, default: undefined, optional,
    };
  }
  const hasDefault = Object.hasOwn(spec, 'default');
  return {
    name, type: spec.type ?? null, description: spec.description ?? null,
    defaultText: hasDefault ? pyRepr(jsToValue(spec.default)) : null, hasDefault, default: spec.default, optional: hasDefault,
  };
}

/** Parameter names from a function's source, or null when they cannot be
 *  read (destructuring, rest parameters, native code). */
export function parameterNames(fn: Function): string[] | null {
  const src = Function.prototype.toString.call(fn);
  let list: string | undefined;
  const single = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(src);
  if (single) return [single[1]];
  const m = /^(?:async\s+)?(?:function\s*\*?\s*[\w$]*\s*|[\w$]+\s*)?\(([\s\S]*?)\)\s*(?:=>|\{)/.exec(src);
  if (!m) return null;
  list = m[1].trim();
  if (list === '') return [];
  // Split on commas outside brackets, so a default like `f(1, 2)` stays whole.
  const pieces: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      pieces.push(list.slice(start, i));
      start = i + 1;
    }
  }
  pieces.push(list.slice(start));
  const names: string[] = [];
  for (const piece of pieces) {
    const p = /^\s*([A-Za-z_$][\w$]*)\s*(?:=[\s\S]*)?$/.exec(piece);
    if (!p) return null;
    names.push(p[1]);
  }
  return names;
}

export function normalizeTools(tools: Tools | ToolDefinition[] | undefined): NormalizedTool[] {
  if (!tools) return [];
  if (Array.isArray(tools)) {
    return tools.map((t) => ({
      name: t.name.replace(/\(\)$/, ''),
      description: t.description ?? null,
      group: t.group ?? null,
      params: (t.parameters ?? []).map((p) => ({
        name: p.name, type: p.type ?? null, description: p.description ?? null,
        defaultText: p.default ?? null, hasDefault: false, default: undefined, optional: p.default !== undefined,
      })),
      mode: 'legacy',
      fn: t.handler,
    }));
  }
  const out: NormalizedTool[] = [];
  for (const name of Object.keys(tools)) {
    const entry = tools[name];
    if (typeof entry === 'function') {
      const names = parameterNames(entry);
      out.push({
        name, description: null, group: null,
        params: (names ?? []).map((n) => ({
          name: n, type: null, description: null, defaultText: null, hasDefault: false, default: undefined, optional: false,
        })),
        mode: names === null ? 'legacy' : 'positional',
        fn: entry,
      });
      continue;
    }
    if (!entry || typeof entry.handler !== 'function') {
      throw new Error(`Tool '${name}' must be a function or an object with a handler function`);
    }
    const params = entry.params ?? {};
    out.push({
      name,
      description: entry.description ?? null,
      group: entry.group ?? null,
      params: Object.keys(params).map((n) => paramInfo(n, params[n])),
      mode: 'object',
      fn: entry.handler,
    });
  }
  return out;
}

// ── Argument resolution ─────────────────────────────────────────────────────

/** The JS arguments to call `tool.fn` with, from marshalled Python
 *  positional arguments and keywords. Raises a Python TypeError for calls a
 *  spec'd tool cannot accept, so the script (and the model) can correct it. */
export function resolveArguments(tool: NormalizedTool, args: any[], kwargs: Record<string, any> | null): any[] {
  if (tool.mode === 'legacy') return [...args, kwargs ?? {}];
  const names = tool.params.map((p) => p.name);

  if (tool.mode === 'object') {
    if (args.length > names.length) {
      throw new TypeError(`${tool.name}() takes ${names.length} positional argument${names.length === 1 ? '' : 's'} but ${args.length} were given`);
    }
    const obj: Record<string, any> = {};
    const seen = new Set<string>();
    names.forEach((n, i) => {
      if (i < args.length) {
        setOwn(obj, n, args[i]);
        seen.add(n);
      }
    });
    if (kwargs) {
      for (const [k, v] of Object.entries(kwargs)) {
        if (!names.includes(k)) throw new TypeError(`${tool.name}() got an unexpected keyword argument '${k}'`);
        if (seen.has(k)) throw new TypeError(`${tool.name}() got multiple values for argument '${k}'`);
        setOwn(obj, k, v);
        seen.add(k);
      }
    }
    for (const p of tool.params) {
      if (seen.has(p.name)) continue;
      if (p.hasDefault) setOwn(obj, p.name, p.default);
      else if (!p.optional) throw new TypeError(`${tool.name}() missing 1 required argument: '${p.name}'`);
    }
    return [obj];
  }

  // Positional: keywords land in the slot named like them; the rest fill the
  // remaining slots in order; whatever is left arrives as one trailing object.
  if (!kwargs) return args;
  const out = args.slice();
  const filled = args.map(() => true);
  const pending: [string, any][] = [];
  for (const [k, v] of Object.entries(kwargs)) {
    const i = names.indexOf(k);
    if (i >= 0 && !filled[i]) {
      out[i] = v;
      filled[i] = true;
    } else pending.push([k, v]);
  }
  const leftover: Record<string, any> = {};
  let anyLeft = false;
  for (const [k, v] of pending) {
    const slot = names.findIndex((_, i) => !filled[i]);
    if (slot >= 0) {
      out[slot] = v;
      filled[slot] = true;
    } else {
      setOwn(leftover, k, v);
      anyLeft = true;
    }
  }
  for (let i = 0; i < out.length; i++) if (!filled[i]) out[i] = undefined;
  if (anyLeft) out.push(leftover);
  return out;
}

// ── Prompt rendering ────────────────────────────────────────────────────────

/** `name(a: str, b: int = 5)` as the model should call it. */
export function renderSignature(tool: NormalizedTool): string {
  const params = tool.params.map((p) => {
    let sig = p.name;
    if (p.type) sig += `: ${p.type}`;
    if (p.defaultText !== null) sig += ` = ${p.defaultText}`;
    return sig;
  });
  return `${tool.name}(${params.join(', ')})`;
}

