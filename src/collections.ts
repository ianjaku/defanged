/**
 * The `collections` module, as an opt-in plugin: Counter, defaultdict,
 * OrderedDict, deque and namedtuple.
 *
 *   import { collections } from 'defanged/collections';
 *   createInterpreter({ modules: [collections] });
 *
 * Pure computation, no state: the module object is a process-wide singleton.
 */

import { IndexError, KeyError, TypeError, ValueError } from './errors';
import { isIntLike } from './numbers';
import { arity, dictUpdate } from './methods';
import {
  Kwargs, MA, NativeFn, PyBuiltin, PyDict, PyFunction, PyList, PyModule, PyObject, PyTuple, PyType, PyValue, Runtime,
  T_DICT, T_TUPLE, andThen, dictGet, dictSet, hashKey, keyError, pyCompare, pyRepr, sameOrEqual, typeName,
} from './values';

type Method = (rt: Runtime, self: any, args: PyValue[], kwargs: Kwargs) => MA<PyValue>;

function table(methods: Record<string, Method>): Record<string, Method> {
  return Object.assign(Object.create(null), methods);
}

function callable(v: PyValue): boolean {
  return v instanceof PyBuiltin || v instanceof PyType || v instanceof PyFunction;
}

// ── Counter ─────────────────────────────────────────────────────────────────

export const T_COUNTER = new PyType('Counter', T_DICT, 'collections.Counter');

class PyCounter extends PyDict {
  get pyType(): PyType {
    return T_COUNTER;
  }
  get extraMethods(): Record<string, unknown> {
    return COUNTER_METHODS;
  }
  /** A missing key counts as 0 and is not inserted. */
  missing(): PyValue {
    return 0;
  }
  reprWith(inner: string): string {
    return inner === '{}' ? 'Counter()' : `Counter(${inner})`;
  }
  binaryOp(op: string, other: PyValue): PyValue | undefined {
    if (!(other instanceof PyCounter)) return undefined;
    const out = new PyCounter();
    const keep = (k: PyValue, n: PyValue) => {
      if (pyCompare('>', n, 0)) dictSet(out, k, n);
    };
    const numeric = (v: PyValue | undefined): PyValue => (v === undefined ? 0 : v);
    switch (op) {
      case '+':
      case '-':
        for (const [k, v] of this.map.values()) keep(k, add(v, op === '-' ? negate(numeric(dictGet(other, k))) : numeric(dictGet(other, k))));
        if (op === '+') for (const [k, v] of other.map.values()) if (!this.map.has(hashKey(k, 'dict key'))) keep(k, v);
        return out;
      case '&':
        for (const [k, v] of this.map.values()) {
          const o = dictGet(other, k);
          if (o !== undefined) keep(k, pyCompare('<', v, o) ? v : o);
        }
        return out;
      case '|':
        for (const [k, v] of this.map.values()) keep(k, pyCompare('>', v, numeric(dictGet(other, k))) ? v : numeric(dictGet(other, k)));
        for (const [k, v] of other.map.values()) if (!this.map.has(hashKey(k, 'dict key'))) keep(k, v);
        return out;
      default:
        return undefined;
    }
  }
}

function add(a: PyValue, b: PyValue): PyValue {
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  throw new TypeError(`unsupported operand type(s) for +: '${typeName(a)}' and '${typeName(b)}'`);
}

function negate(a: PyValue): PyValue {
  if (typeof a === 'number') return -a;
  throw new TypeError(`bad operand type for unary -: '${typeName(a)}'`);
}

/** Adds counts from an iterable of items or a mapping of counts. */
function countInto(rt: Runtime, counter: PyCounter, source: PyValue | undefined, kwargs: Kwargs, sign: 1 | -1): MA<void> {
  const bump = (key: PyValue, by: PyValue) => {
    const current = dictGet(counter, key) ?? 0;
    dictSet(counter, key, add(current, sign === 1 ? by : negate(by)));
  };
  const fromKeywords = () => {
    if (kwargs) for (const [k, v] of kwargs) bump(k, v);
  };
  if (source === undefined || source === null) return fromKeywords();
  if (source instanceof PyDict) {
    for (const [k, v] of source.map.values()) bump(k, v);
    return fromKeywords();
  }
  return andThen(rt.forEach(source, (item) => { bump(item, 1); }), fromKeywords);
}

const COUNTER_METHODS = table({
  most_common(_rt, self: PyCounter, args) {
    arity('most_common', args, 0, 1);
    const entries = Array.from(self.map.values()).map((e, i) => ({ e, i }));
    entries.sort((a, b) => (pyCompare('>', a.e[1], b.e[1]) ? -1 : pyCompare('<', a.e[1], b.e[1]) ? 1 : a.i - b.i));
    const n = args[0] === undefined || args[0] === null ? entries.length : Number(args[0]);
    return new PyList(entries.slice(0, Math.max(0, n)).map(({ e }) => new PyTuple([e[0], e[1]])));
  },
  elements(rt, self: PyCounter) {
    const out: PyValue[] = [];
    for (const [k, v] of self.map.values()) {
      const n = typeof v === 'number' ? v : 0;
      rt.checkCollection(out.length + n);
      for (let i = 0; i < n; i++) out.push(k);
    }
    return rt.iter(new PyList(out));
  },
  total(_rt, self: PyCounter) {
    let total: PyValue = 0;
    for (const [, v] of self.map.values()) total = add(total, v);
    return total;
  },
  update(rt, self: PyCounter, args, kwargs) {
    arity('update', args, 0, 1);
    return andThen(countInto(rt, self, args[0], kwargs, 1), () => null);
  },
  subtract(rt, self: PyCounter, args, kwargs) {
    arity('subtract', args, 0, 1);
    return andThen(countInto(rt, self, args[0], kwargs, -1), () => null);
  },
  copy(_rt, self: PyCounter) {
    const out = new PyCounter();
    for (const [hk, entry] of self.map) out.map.set(hk, [entry[0], entry[1]]);
    return out;
  },
});

T_COUNTER.construct = (rt, args, kwargs) => {
  arity('Counter', args, 0, 1);
  const counter = new PyCounter();
  return andThen(countInto(rt, counter, args[0], kwargs, 1), () => counter);
};

// ── defaultdict ─────────────────────────────────────────────────────────────

export const T_DEFAULTDICT = new PyType('defaultdict', T_DICT, 'collections.defaultdict');

class PyDefaultDict extends PyDict {
  constructor(readonly factory: PyValue) {
    super();
  }
  get pyType(): PyType {
    return T_DEFAULTDICT;
  }
  get extraMethods(): Record<string, unknown> {
    return DEFAULTDICT_METHODS;
  }
  missing(rt: Runtime, key: PyValue): MA<PyValue> | undefined {
    if (this.factory === null) return undefined;
    return andThen(rt.call(this.factory, []), (made) => {
      dictSet(this, key, made);
      return made;
    });
  }
  reprWith(inner: string): string {
    return `defaultdict(${pyRepr(this.factory)}, ${inner})`;
  }
}

const DEFAULTDICT_METHODS = table({
  copy(_rt, self: PyDefaultDict) {
    const out = new PyDefaultDict(self.factory);
    for (const [hk, entry] of self.map) out.map.set(hk, [entry[0], entry[1]]);
    return out;
  },
});

T_DEFAULTDICT.construct = (rt, args, kwargs) => {
  arity('defaultdict', args, 0, 2);
  const factory = args[0] ?? null;
  if (factory !== null && !callable(factory)) throw new TypeError('first argument must be callable or None');
  const dict = new PyDefaultDict(factory);
  return andThen(dictUpdate(rt, dict, args[1], kwargs), () => dict);
};

// ── OrderedDict ─────────────────────────────────────────────────────────────

export const T_ORDEREDDICT = new PyType('OrderedDict', T_DICT, 'collections.OrderedDict');

class PyOrderedDict extends PyDict {
  get pyType(): PyType {
    return T_ORDEREDDICT;
  }
  get extraMethods(): Record<string, unknown> {
    return ORDEREDDICT_METHODS;
  }
  reprWith(inner: string): string {
    return inner === '{}' ? 'OrderedDict()' : `OrderedDict(${inner})`;
  }
}

const ORDEREDDICT_METHODS = table({
  move_to_end(_rt, self: PyOrderedDict, args, kwargs) {
    arity('move_to_end', args, 1, 2);
    const last = (args[1] ?? kwargs?.get('last') ?? true) !== false;
    const hk = hashKey(args[0], 'dict key');
    const entry = self.map.get(hk);
    if (entry === undefined) throw keyError(args[0]);
    self.map.delete(hk);
    if (last) {
      self.map.set(hk, entry);
    } else {
      const rest = Array.from(self.map);
      self.map.clear();
      self.map.set(hk, entry);
      for (const [k, v] of rest) self.map.set(k, v);
    }
    return null;
  },
  popitem(_rt, self: PyOrderedDict, args, kwargs) {
    arity('popitem', args, 0, 1);
    const last = (args[0] ?? kwargs?.get('last') ?? true) !== false;
    const entries = Array.from(self.map);
    if (entries.length === 0) throw new KeyError("'dictionary is empty'");
    const [hk, entry] = last ? entries[entries.length - 1] : entries[0];
    self.map.delete(hk);
    return new PyTuple([entry[0], entry[1]]);
  },
  copy(_rt, self: PyOrderedDict) {
    const out = new PyOrderedDict();
    for (const [hk, entry] of self.map) out.map.set(hk, [entry[0], entry[1]]);
    return out;
  },
});

T_ORDEREDDICT.construct = (rt, args, kwargs) => {
  arity('OrderedDict', args, 0, 1);
  const dict = new PyOrderedDict();
  return andThen(dictUpdate(rt, dict, args[0], kwargs), () => dict);
};

// ── deque ───────────────────────────────────────────────────────────────────

export const T_DEQUE = new PyType('deque', null, 'collections.deque');

class PyDeque extends PyObject {
  readonly typeName = 'collections.deque';
  items: PyValue[] = [];
  constructor(readonly maxlen: number | null) {
    super();
  }

  push(item: PyValue, left: boolean): void {
    if (left) this.items.unshift(item);
    else this.items.push(item);
    if (this.maxlen !== null && this.items.length > this.maxlen) {
      if (left) this.items.pop();
      else this.items.shift();
    }
  }

  length(): number {
    return this.items.length;
  }
  iterate(): PyValue[] {
    return this.items.slice();
  }
  getItem(key: PyValue): PyValue {
    if (!isIntLike(key)) throw new TypeError(`sequence index must be integer, not '${typeName(key)}'`);
    const n = Number(key);
    const i = n < 0 ? n + this.items.length : n;
    if (i < 0 || i >= this.items.length) throw new IndexError('deque index out of range');
    return this.items[i];
  }
  repr(): string {
    const inner = pyRepr(new PyList(this.items));
    return this.maxlen === null ? `deque(${inner})` : `deque(${inner}, maxlen=${this.maxlen})`;
  }
  getAttr(name: string): PyValue | undefined {
    if (name === 'maxlen') return this.maxlen;
    const method = DEQUE_METHODS[name];
    if (method === undefined) return undefined;
    return new PyBuiltin(name, (rt, args, kwargs) => method(rt, this, args, kwargs), true);
  }
}

const DEQUE_METHODS = table({
  append(_rt, self: PyDeque, args) {
    arity('append', args, 1);
    self.push(args[0], false);
    return null;
  },
  appendleft(_rt, self: PyDeque, args) {
    arity('appendleft', args, 1);
    self.push(args[0], true);
    return null;
  },
  pop(_rt, self: PyDeque, args) {
    arity('pop', args, 0);
    if (self.items.length === 0) throw new IndexError('pop from an empty deque');
    return self.items.pop()!;
  },
  popleft(_rt, self: PyDeque, args) {
    arity('popleft', args, 0);
    if (self.items.length === 0) throw new IndexError('pop from an empty deque');
    return self.items.shift()!;
  },
  extend(rt, self: PyDeque, args) {
    arity('extend', args, 1);
    return andThen(rt.collect(args[0]), (items) => {
      for (const item of items.slice()) self.push(item, false);
      return null;
    });
  },
  extendleft(rt, self: PyDeque, args) {
    arity('extendleft', args, 1);
    return andThen(rt.collect(args[0]), (items) => {
      for (const item of items.slice()) self.push(item, true);
      return null;
    });
  },
  clear(_rt, self: PyDeque) {
    self.items = [];
    return null;
  },
  rotate(_rt, self: PyDeque, args) {
    arity('rotate', args, 0, 1);
    const n = args.length ? Number(args[0]) : 1;
    const len = self.items.length;
    if (len === 0) return null;
    const k = ((n % len) + len) % len;
    self.items = self.items.slice(len - k).concat(self.items.slice(0, len - k));
    return null;
  },
  count(_rt, self: PyDeque, args) {
    arity('count', args, 1);
    return self.items.filter((item) => sameOrEqual(item, args[0])).length;
  },
  index(_rt, self: PyDeque, args) {
    arity('index', args, 1);
    const at = self.items.findIndex((item) => sameOrEqual(item, args[0]));
    if (at < 0) throw new ValueError(`${pyRepr(args[0])} is not in deque`);
    return at;
  },
  remove(_rt, self: PyDeque, args) {
    arity('remove', args, 1);
    const at = self.items.findIndex((item) => sameOrEqual(item, args[0]));
    if (at < 0) throw new ValueError(`${pyRepr(args[0])} is not in deque`);
    self.items.splice(at, 1);
    return null;
  },
  reverse(_rt, self: PyDeque) {
    self.items.reverse();
    return null;
  },
  copy(_rt, self: PyDeque) {
    const out = new PyDeque(self.maxlen);
    out.items = self.items.slice();
    return out;
  },
});

T_DEQUE.construct = (rt, args, kwargs) => {
  arity('deque', args, 0, 2);
  const maxlenArg = args[1] ?? kwargs?.get('maxlen') ?? null;
  if (maxlenArg !== null && (!isIntLike(maxlenArg) || Number(maxlenArg) < 0)) {
    throw new ValueError('maxlen must be non-negative');
  }
  const deque = new PyDeque(maxlenArg === null ? null : Number(maxlenArg));
  if (args[0] === undefined) return deque;
  return andThen(rt.collect(args[0]), (items) => {
    for (const item of items.slice()) deque.push(item, false);
    return deque;
  });
};

// ── namedtuple ──────────────────────────────────────────────────────────────

class PyNamedTuple extends PyTuple {
  constructor(items: PyValue[], readonly type: PyType, readonly fields: string[]) {
    super(items);
  }
  get pyType(): PyType {
    return this.type;
  }
  getAttr(name: string): PyValue | undefined {
    const at = this.fields.indexOf(name);
    if (at >= 0) return this.items[at];
    switch (name) {
      case '_fields': return new PyTuple(this.fields.slice());
      case '_asdict': return new PyBuiltin('_asdict', () => {
        const dict = new PyDict();
        this.fields.forEach((f, i) => dictSet(dict, f, this.items[i]));
        return dict;
      });
      case '_replace': return new PyBuiltin('_replace', (_rt, args, kwargs) => {
        if (args.length > 0) throw new TypeError('_replace() takes no positional arguments');
        const items = this.items.slice();
        for (const [k, v] of kwargs ?? []) {
          const i = this.fields.indexOf(k);
          if (i < 0) throw new ValueError(`Got unexpected field names: ['${k}']`);
          items[i] = v;
        }
        return new PyNamedTuple(items, this.type, this.fields);
      }, true);
      default: return undefined;
    }
  }
  reprWith(): string {
    return `${this.type.name}(${this.fields.map((f, i) => `${f}=${pyRepr(this.items[i])}`).join(', ')})`;
  }
}

function namedtuple(rt: Runtime, args: PyValue[], kwargs: Kwargs): MA<PyValue> {
  arity('namedtuple', args, 2);
  const name = args[0];
  if (typeof name !== 'string' || !/^[A-Za-z_]\w*$/.test(name)) {
    throw new ValueError(`Type names and field names must be valid identifiers: ${pyRepr(name)}`);
  }
  const fieldsArg = typeof args[1] === 'string' ? new PyList(args[1].replace(/,/g, ' ').split(/\s+/).filter(Boolean)) : args[1];
  return andThen(rt.collect(fieldsArg), (raw) => {
    const fields = raw.map((f) => {
      if (typeof f !== 'string' || !/^[A-Za-z_]\w*$/.test(f) || f.startsWith('_')) {
        throw new ValueError(`Type names and field names must be valid identifiers: ${pyRepr(f)}`);
      }
      return f;
    });
    if (new Set(fields).size !== fields.length) throw new ValueError('Encountered duplicate field name');
    const defaults = kwargs?.get('defaults');
    const defaultValues = defaults instanceof PyTuple || defaults instanceof PyList ? defaults.items : [];

    const type = new PyType(name, T_TUPLE, name);
    type.construct = (_rt, cargs, ckwargs) => {
      const items: (PyValue | undefined)[] = cargs.slice();
      if (items.length > fields.length) {
        throw new TypeError(`${name}.__new__() takes ${fields.length + 1} positional arguments but ${items.length + 1} were given`);
      }
      for (const [k, v] of ckwargs ?? []) {
        const i = fields.indexOf(k);
        if (i < 0) throw new TypeError(`${name}() got an unexpected keyword argument '${k}'`);
        if (items[i] !== undefined) throw new TypeError(`${name}() got multiple values for argument '${k}'`);
        items[i] = v;
      }
      const firstDefault = fields.length - defaultValues.length;
      for (let i = 0; i < fields.length; i++) {
        if (items[i] !== undefined) continue;
        if (i >= firstDefault) items[i] = defaultValues[i - firstDefault];
        else throw new TypeError(`${name}.__new__() missing 1 required positional argument: '${fields[i]}'`);
      }
      return new PyNamedTuple(items as PyValue[], type, fields);
    };
    type.attrs = new Map<string, PyValue>([['_fields', new PyTuple(fields.slice())]]);
    return type;
  });
}

// ── Module ──────────────────────────────────────────────────────────────────

export const collections: PyModule = new PyModule('collections', new Map<string, PyValue>([
  ['Counter', T_COUNTER],
  ['defaultdict', T_DEFAULTDICT],
  ['OrderedDict', T_ORDEREDDICT],
  ['deque', T_DEQUE],
  ['namedtuple', new PyBuiltin('namedtuple', namedtuple as NativeFn, true)],
]));
