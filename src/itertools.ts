/**
 * The `itertools` module, as an opt-in plugin.
 *
 *   import { itertools } from 'defanged/itertools';
 *   createInterpreter({ modules: [itertools] });
 *
 * Every function returns a lazy iterator, as in CPython. Pure computation,
 * no state: the module object is a process-wide singleton.
 */

import { TypeError, ValueError } from './errors';
import { binary } from './ops';
import {
  DONE, Done, MA, NativeFn, PyBuiltin, PyIterator, PyModule, PyTuple, PyValue, Runtime,
  andThen, pyEquals, truthy, typeName,
} from './values';
import { BinOp } from './vm';

function arity(name: string, args: PyValue[], min: number, max: number = min): void {
  if (args.length >= min && args.length <= max) return;
  throw new TypeError(args.length < min
    ? `${name}() missing required argument`
    : `${name}() takes at most ${max} argument${max === 1 ? '' : 's'} (${args.length} given)`);
}

function count(name: string, v: PyValue | undefined, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new TypeError(`${name}: '${typeName(v)}' object cannot be interpreted as an integer`);
}

// ── Iterators ───────────────────────────────────────────────────────────────

class CountIterator extends PyIterator {
  readonly typeName = 'count';
  constructor(private current: PyValue, private readonly step: PyValue) {
    super();
  }
  next(rt: Runtime): PyValue | Done {
    const v = this.current;
    this.current = binary(rt, BinOp.ADD, this.current, this.step);
    return v;
  }
}

class CycleIterator extends PyIterator {
  readonly typeName = 'cycle';
  private saved: PyValue[] = [];
  private index = -1;
  constructor(private readonly inner: PyValue) {
    super();
  }
  next(rt: Runtime): MA<PyValue | Done> {
    if (this.index >= 0) {
      if (this.saved.length === 0) return DONE;
      const v = this.saved[this.index];
      this.index = (this.index + 1) % this.saved.length;
      return v;
    }
    return andThen(rt.next(this.inner), (v) => {
      if (v !== DONE) {
        this.saved.push(v);
        rt.checkCollection(this.saved.length);
        return v;
      }
      this.index = 0;
      return this.next(rt);
    });
  }
}

class RepeatIterator extends PyIterator {
  readonly typeName = 'repeat';
  constructor(private readonly value: PyValue, private remaining: number) {
    super();
  }
  next(): PyValue | Done {
    if (this.remaining === 0) return DONE;
    if (this.remaining > 0) this.remaining--;
    return this.value;
  }
}

class AccumulateIterator extends PyIterator {
  readonly typeName = 'accumulate';
  private total: PyValue | undefined;
  constructor(private readonly inner: PyValue, private readonly fn: PyValue | null, initial: PyValue | undefined) {
    super();
    this.total = initial;
    this.pendingInitial = initial !== undefined;
  }
  next(rt: Runtime): MA<PyValue | Done> {
    if (this.total !== undefined && this.pendingInitial) {
      this.pendingInitial = false;
      return this.total;
    }
    return andThen(rt.next(this.inner), (v) => {
      if (v === DONE) return DONE;
      if (this.total === undefined) return (this.total = v);
      const combined = this.fn === null ? binary(rt, BinOp.ADD, this.total, v) : rt.call(this.fn, [this.total, v]);
      return andThen(combined, (r) => (this.total = r));
    });
  }
  private pendingInitial: boolean;
}

class SliceIterator extends PyIterator {
  readonly typeName = 'islice';
  private index = 0;
  constructor(private readonly inner: PyValue, private readonly start: number, private readonly stop: number | null, private readonly step: number) {
    super();
  }
  next(rt: Runtime): MA<PyValue | Done> {
    const advance = (): MA<PyValue | Done> => {
      if (this.stop !== null && this.index >= this.stop) return DONE;
      return andThen(rt.next(this.inner), (v) => {
        if (v === DONE) return DONE;
        const i = this.index++;
        return i >= this.start && (i - this.start) % this.step === 0 ? v : advance();
      });
    };
    return advance();
  }
}

class WhileIterator extends PyIterator {
  private dropping = true;
  private done = false;
  constructor(readonly typeName: 'takewhile' | 'dropwhile', private readonly fn: PyValue, private readonly inner: PyValue) {
    super();
  }
  next(rt: Runtime): MA<PyValue | Done> {
    if (this.done) return DONE;
    const step = (): MA<PyValue | Done> => andThen(rt.next(this.inner), (v) => {
      if (v === DONE) return DONE;
      if (this.typeName === 'dropwhile' && !this.dropping) return v;
      return andThen(rt.call(this.fn, [v]), (keep) => {
        if (this.typeName === 'takewhile') {
          if (truthy(keep)) return v;
          this.done = true;
          return DONE;
        }
        if (truthy(keep)) return step();
        this.dropping = false;
        return v;
      });
    });
    return step();
  }
}

class FilterFalseIterator extends PyIterator {
  readonly typeName = 'filterfalse';
  constructor(private readonly fn: PyValue, private readonly inner: PyValue) {
    super();
  }
  next(rt: Runtime): MA<PyValue | Done> {
    const step = (): MA<PyValue | Done> => andThen(rt.next(this.inner), (v) => {
      if (v === DONE) return DONE;
      const test = this.fn === null ? v : rt.call(this.fn, [v]);
      return andThen(test, (keep) => (truthy(keep) ? step() : v));
    });
    return step();
  }
}

/** groupby: the parent and the current group share one underlying iterator,
 *  so advancing the parent discards the rest of the group, as in CPython. */
class GroupByIterator extends PyIterator {
  readonly typeName = 'groupby';
  private currentKey: PyValue | undefined;
  private currentValue: PyValue | undefined;
  private targetKey: PyValue | undefined;
  private exhausted = false;
  constructor(private readonly inner: PyValue, private readonly keyFn: PyValue | null) {
    super();
  }

  /** Reads the next (key, value) from the underlying iterator. */
  private advance(rt: Runtime): MA<boolean> {
    return andThen(rt.next(this.inner), (v) => {
      if (v === DONE) {
        this.exhausted = true;
        return false;
      }
      return andThen(this.keyFn === null ? v : rt.call(this.keyFn, [v]), (k) => {
        this.currentKey = k;
        this.currentValue = v;
        return true;
      });
    });
  }

  next(rt: Runtime): MA<PyValue | Done> {
    const skip = (): MA<PyValue | Done> => {
      if (this.exhausted) return DONE;
      if (this.currentValue === undefined || (this.targetKey !== undefined && pyEquals(this.currentKey!, this.targetKey))) {
        return andThen(this.advance(rt), (more) => (more ? skip() : DONE));
      }
      this.targetKey = this.currentKey;
      const key = this.currentKey!;
      return new PyTuple([key, new GroupIterator(this, key)]);
    };
    return skip();
  }

  /** The next member of the group for `key`, or DONE when the key changes. */
  nextInGroup(rt: Runtime, key: PyValue): MA<PyValue | Done> {
    if (this.exhausted || this.currentKey !== undefined && this.targetKey !== key) return DONE;
    if (this.currentValue === undefined) {
      return andThen(this.advance(rt), (more) => (more ? this.nextInGroup(rt, key) : DONE));
    }
    if (!pyEquals(this.currentKey!, key)) return DONE;
    const v = this.currentValue;
    this.currentValue = undefined;
    return v;
  }
}

class GroupIterator extends PyIterator {
  readonly typeName = '_grouper';
  constructor(private readonly parent: GroupByIterator, private readonly key: PyValue) {
    super();
  }
  next(rt: Runtime): MA<PyValue | Done> {
    return this.parent.nextInGroup(rt, this.key);
  }
}

class ZipLongestIterator extends PyIterator {
  readonly typeName = 'zip_longest';
  private active: boolean[];
  constructor(private readonly iterators: PyValue[], private readonly fill: PyValue) {
    super();
    this.active = iterators.map(() => true);
  }
  next(rt: Runtime): MA<PyValue | Done> {
    const items: PyValue[] = [];
    let alive = 0;
    const step = (i: number): MA<PyValue | Done> => {
      for (; i < this.iterators.length; i++) {
        if (!this.active[i]) {
          items.push(this.fill);
          continue;
        }
        const r = rt.next(this.iterators[i]);
        if (r instanceof Promise) {
          const at = i;
          return r.then((v) => {
            if (v === DONE) {
              this.active[at] = false;
              items.push(this.fill);
            } else {
              alive++;
              items.push(v);
            }
            return step(at + 1);
          });
        }
        if (r === DONE) {
          this.active[i] = false;
          items.push(this.fill);
        } else {
          alive++;
          items.push(r);
        }
      }
      return alive === 0 ? DONE : new PyTuple(items);
    };
    return step(0);
  }
}

class StarmapIterator extends PyIterator {
  readonly typeName = 'starmap';
  constructor(private readonly fn: PyValue, private readonly inner: PyValue) {
    super();
  }
  next(rt: Runtime): MA<PyValue | Done> {
    return andThen(rt.next(this.inner), (v) => {
      if (v === DONE) return DONE;
      return andThen(rt.collect(v), (args) => rt.call(this.fn, args.slice()));
    });
  }
}

class PairwiseIterator extends PyIterator {
  readonly typeName = 'pairwise';
  private previous: PyValue | undefined;
  constructor(private readonly inner: PyValue) {
    super();
  }
  next(rt: Runtime): MA<PyValue | Done> {
    const first = this.previous === undefined ? rt.next(this.inner) : this.previous;
    return andThen(first, (a) => {
      if (a === DONE) return DONE;
      return andThen(rt.next(this.inner), (b) => {
        if (b === DONE) return DONE;
        this.previous = b;
        return new PyTuple([a, b]);
      });
    });
  }
}

class BatchedIterator extends PyIterator {
  readonly typeName = 'batched';
  constructor(private readonly inner: PyValue, private readonly size: number) {
    super();
  }
  next(rt: Runtime): MA<PyValue | Done> {
    const batch: PyValue[] = [];
    const step = (): MA<PyValue | Done> => {
      if (batch.length === this.size) return new PyTuple(batch);
      return andThen(rt.next(this.inner), (v) => {
        if (v !== DONE) {
          batch.push(v);
          return step();
        }
        return batch.length === 0 ? DONE : new PyTuple(batch);
      });
    };
    return step();
  }
}

/** Yields index tuples in lexicographic order; `next` maps them to items. */
class IndexTupleIterator extends PyIterator {
  private indices: number[] | null = null;
  private finished = false;
  constructor(
    readonly typeName: string,
    private readonly pools: PyValue[][],
    private readonly advance: (indices: number[], pools: PyValue[][]) => boolean,
    private readonly first: (pools: PyValue[][]) => number[] | null,
  ) {
    super();
  }
  next(): PyValue | Done {
    if (this.finished) return DONE;
    if (this.indices === null) {
      this.indices = this.first(this.pools);
      if (this.indices === null) {
        this.finished = true;
        return DONE;
      }
    } else if (!this.advance(this.indices, this.pools)) {
      this.finished = true;
      return DONE;
    }
    return new PyTuple(this.indices.map((index, i) => this.pools[i][index]));
  }
}

function product(pools: PyValue[][]): PyIterator {
  return new IndexTupleIterator('product', pools,
    (indices, pools) => {
      for (let i = indices.length - 1; i >= 0; i--) {
        if (++indices[i] < pools[i].length) return true;
        indices[i] = 0;
      }
      return false;
    },
    (pools) => (pools.some((p) => p.length === 0) ? null : pools.map(() => 0)));
}

function permutations(items: PyValue[], r: number): PyIterator {
  const n = items.length;
  const pools = Array.from({ length: r }, () => items);
  return new IndexTupleIterator('permutations', pools,
    (indices) => {
      // Next r-permutation of 0..n-1 in lexicographic order.
      const used = new Set(indices);
      for (let i = r - 1; i >= 0; i--) {
        used.delete(indices[i]);
        for (let candidate = indices[i] + 1; candidate < n; candidate++) {
          if (used.has(candidate)) continue;
          indices[i] = candidate;
          used.add(candidate);
          for (let j = i + 1; j < r; j++) {
            let c = 0;
            while (used.has(c)) c++;
            indices[j] = c;
            used.add(c);
          }
          return true;
        }
      }
      return false;
    },
    () => (r > n ? null : Array.from({ length: r }, (_, i) => i)));
}

function combinations(items: PyValue[], r: number, withReplacement: boolean): PyIterator {
  const n = items.length;
  const pools = Array.from({ length: r }, () => items);
  return new IndexTupleIterator(withReplacement ? 'combinations_with_replacement' : 'combinations', pools,
    (indices) => {
      for (let i = r - 1; i >= 0; i--) {
        const limit = withReplacement ? n - 1 : n - r + i;
        if (indices[i] < limit) {
          indices[i]++;
          for (let j = i + 1; j < r; j++) indices[j] = withReplacement ? indices[i] : indices[j - 1] + 1;
          return true;
        }
      }
      return false;
    },
    () => {
      if (r === 0) return [];
      if (withReplacement ? n === 0 : r > n) return null;
      return Array.from({ length: r }, (_, i) => (withReplacement ? 0 : i));
    });
}

// ── Module ──────────────────────────────────────────────────────────────────

function fn(name: string, impl: NativeFn, kw: boolean = false): [string, PyValue] {
  return [name, new PyBuiltin(name, impl, kw)];
}

/** Materializes every argument; product and friends need the whole input. */
function collectAll(rt: Runtime, args: PyValue[]): MA<PyValue[][]> {
  const out: PyValue[][] = [];
  const step = (i: number): MA<PyValue[][]> => {
    for (; i < args.length; i++) {
      const r = rt.collect(args[i]);
      if (r instanceof Promise) {
        const at = i;
        return r.then((items) => {
          out.push(items.slice());
          return step(at + 1);
        });
      }
      out.push(r.slice());
    }
    return out;
  };
  return step(0);
}

const chain = new PyBuiltin('chain', (rt, args) => {
  // One lazy pass over each argument in turn.
  const iterators = args.map((a) => rt.iter(a));
  let index = 0;
  return new (class extends PyIterator {
    readonly typeName = 'chain';
    next(rt: Runtime): MA<PyValue | Done> {
      const step = (): MA<PyValue | Done> => {
        if (index >= iterators.length) return DONE;
        return andThen(rt.next(iterators[index]), (v) => {
          if (v !== DONE) return v;
          index++;
          return step();
        });
      };
      return step();
    }
  })();
});
chain.attrs = new Map<string, PyValue>([['from_iterable', new PyBuiltin('from_iterable', (rt, args) => {
    arity('from_iterable', args, 1);
    const outer = rt.iter(args[0]);
    let current: PyValue | null = null;
    return new (class extends PyIterator {
      readonly typeName = 'chain';
      next(rt: Runtime): MA<PyValue | Done> {
        const step = (): MA<PyValue | Done> => {
          if (current === null) {
            return andThen(rt.next(outer), (it) => {
              if (it === DONE) return DONE;
              current = rt.iter(it);
              return step();
            });
          }
          return andThen(rt.next(current), (v) => {
            if (v !== DONE) return v;
            current = null;
            return step();
          });
        };
        return step();
      }
    })();
  })]]);

export const itertools: PyModule = new PyModule('itertools', new Map<string, PyValue>([
  fn('count', (_rt, args, kwargs) => {
    arity('count', args, 0, 2);
    const start = args[0] ?? kwargs?.get('start') ?? 0;
    const step = args[1] ?? kwargs?.get('step') ?? 1;
    return new CountIterator(start, step);
  }, true),
  fn('cycle', (rt, args) => {
    arity('cycle', args, 1);
    return new CycleIterator(rt.iter(args[0]));
  }),
  fn('repeat', (_rt, args, kwargs) => {
    arity('repeat', args, 1, 2);
    const times = args[1] ?? kwargs?.get('times');
    return new RepeatIterator(args[0], times === undefined ? -1 : Math.max(0, count('repeat', times, 0)));
  }, true),
  fn('accumulate', (rt, args, kwargs) => {
    arity('accumulate', args, 1, 2);
    const func = args[1] ?? kwargs?.get('func') ?? null;
    return new AccumulateIterator(rt.iter(args[0]), func, kwargs?.get('initial') ?? undefined);
  }, true),
  fn('islice', (rt, args) => {
    arity('islice', args, 2, 4);
    const stopOnly = args.length === 2;
    const start = stopOnly ? 0 : count('islice', args[1], 0);
    const stopArg = stopOnly ? args[1] : args[2];
    const stop = stopArg === null || stopArg === undefined ? null : count('islice', stopArg, 0);
    const step = args.length === 4 ? count('islice', args[3], 1) : 1;
    if (start < 0 || (stop !== null && stop < 0) || step < 1) {
      throw new ValueError('Indices for islice() must be None or an integer: 0 <= x <= sys.maxsize.');
    }
    return new SliceIterator(rt.iter(args[0]), start, stop, step);
  }),
  fn('takewhile', (rt, args) => {
    arity('takewhile', args, 2);
    return new WhileIterator('takewhile', args[0], rt.iter(args[1]));
  }),
  fn('dropwhile', (rt, args) => {
    arity('dropwhile', args, 2);
    return new WhileIterator('dropwhile', args[0], rt.iter(args[1]));
  }),
  fn('filterfalse', (rt, args) => {
    arity('filterfalse', args, 2);
    return new FilterFalseIterator(args[0], rt.iter(args[1]));
  }),
  fn('groupby', (rt, args, kwargs) => {
    arity('groupby', args, 1, 2);
    return new GroupByIterator(rt.iter(args[0]), args[1] ?? kwargs?.get('key') ?? null);
  }, true),
  fn('zip_longest', (rt, args, kwargs) => {
    return new ZipLongestIterator(args.map((a) => rt.iter(a)), kwargs?.get('fillvalue') ?? null);
  }, true),
  fn('starmap', (rt, args) => {
    arity('starmap', args, 2);
    return new StarmapIterator(args[0], rt.iter(args[1]));
  }),
  fn('pairwise', (rt, args) => {
    arity('pairwise', args, 1);
    return new PairwiseIterator(rt.iter(args[0]));
  }),
  fn('batched', (rt, args, kwargs) => {
    arity('batched', args, 1, 2);
    const n = count('batched', args[1] ?? kwargs?.get('n'), 0);
    if (n < 1) throw new ValueError('n must be at least one');
    return new BatchedIterator(rt.iter(args[0]), n);
  }, true),
  fn('product', (rt, args, kwargs) => {
    const repeat = count('product', kwargs?.get('repeat'), 1);
    return andThen(collectAll(rt, args), (pools) => {
      const all: PyValue[][] = [];
      for (let i = 0; i < repeat; i++) all.push(...pools);
      return product(all);
    });
  }, true),
  fn('permutations', (rt, args, kwargs) => {
    arity('permutations', args, 1, 2);
    return andThen(rt.collect(args[0]), (items) => {
      const rArg = args[1] ?? kwargs?.get('r');
      return permutations(items.slice(), rArg === undefined || rArg === null ? items.length : count('permutations', rArg, 0));
    });
  }, true),
  fn('combinations', (rt, args) => {
    arity('combinations', args, 2);
    return andThen(rt.collect(args[0]), (items) => combinations(items.slice(), count('combinations', args[1], 0), false));
  }),
  fn('combinations_with_replacement', (rt, args) => {
    arity('combinations_with_replacement', args, 2);
    return andThen(rt.collect(args[0]), (items) => combinations(items.slice(), count('combinations_with_replacement', args[1], 0), true));
  }),
  ['chain', chain],
]));
