/**
 * The `random` module, as an opt-in plugin.
 *
 *   import { random } from 'defanged/random';
 *   createInterpreter({ modules: [random] });
 *
 * The generator is CPython's Mersenne Twister, ported step for step, so a
 * script that calls `random.seed(42)` gets the numbers CPython gives it.
 * Unseeded, each interpreter starts from OS entropy, and keeps its own state
 * between runs the way one Python process does. Seeds must be ints: CPython
 * hashes str seeds with SHA-512, which is not worth carrying here.
 *
 * `getstate`/`setstate` and `randbytes` are left out.
 */

import { IndexError, TypeError, ValueError } from './errors';
import { PyFloat, PyInt, bitLength, intAdd, intFloorDiv, intMul, intSub, isIntLike, isNum, normBig, numBinary, numCompare, toFloat } from './numbers';
import { getItem } from './ops';
import {
  Kwargs, MA, PyBuiltin, PyDict, PyList, PyModule, PyObject, PyRange, PyTuple, PyValue, Runtime,
  andThen, namedType, pyStr, strLength, typeName,
} from './values';

// ── Mersenne Twister (MT19937), the generator behind CPython's random ───────

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER = 0x80000000;
const LOWER = 0x7fffffff;

class MersenneTwister {
  private readonly mt = new Uint32Array(N);
  private index = N + 1;
  /** Second normal variate from the last `gauss` call, like CPython caches. */
  gaussNext: number | null = null;

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s;
    for (let i = 1; i < N; i++) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = Math.imul(1812433253, prev) + i;
    }
    this.index = N;
  }

  /** Seeds from 32-bit words; `init_by_array` in CPython's _randommodule.c. */
  initByArray(key: ArrayLike<number>): void {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k > 0; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (mt[i] ^ Math.imul(prev, 1664525)) + key[j] + j;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1];
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (mt[i] ^ Math.imul(prev, 1566083941)) - i;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1];
        i = 1;
      }
    }
    mt[0] = 0x80000000;
    this.gaussNext = null;
  }

  seedFromInt(n: bigint): void {
    // CPython splits |n| into 32-bit words, least significant first.
    let mag = n < 0n ? -n : n;
    const key: number[] = [];
    do {
      key.push(Number(mag & 0xffffffffn));
      mag >>= 32n;
    } while (mag > 0n);
    this.initByArray(key);
  }

  seedFromEntropy(): void {
    const key = new Uint32Array(N);
    globalThis.crypto.getRandomValues(key);
    this.initByArray(key);
  }

  /** The next 32-bit word. */
  genrand(): number {
    const mt = this.mt;
    if (this.index >= N) {
      let kk = 0;
      for (; kk < N - M; kk++) {
        const y = (mt[kk] & UPPER) | (mt[kk + 1] & LOWER);
        mt[kk] = mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      for (; kk < N - 1; kk++) {
        const y = (mt[kk] & UPPER) | (mt[kk + 1] & LOWER);
        mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      const y = (mt[N - 1] & UPPER) | (mt[0] & LOWER);
      mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      this.index = 0;
    }
    let y = mt[this.index++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** A float in [0, 1) with 53 random bits, from two words like CPython. */
  random(): number {
    const a = this.genrand() >>> 5;
    const b = this.genrand() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  getrandbits(k: number): PyInt {
    if (k === 0) return 0;
    if (k <= 32) return this.genrand() >>> (32 - k);
    if (k <= 53) {
      const low = this.genrand();
      return (this.genrand() >>> (64 - k)) * 4294967296 + low;
    }
    // Wider results are assembled from 32-bit words, least significant first.
    let result = 0n;
    for (let shift = 0n; k > 0; k -= 32, shift += 32n) {
      let word = this.genrand();
      if (k < 32) word >>>= 32 - k;
      result |= BigInt(word) << shift;
    }
    return normBig(result);
  }

  /** A random int in [0, n), by rejection like CPython's `_randbelow`. */
  randbelow(n: PyInt): PyInt {
    const k = typeof n === 'bigint' ? bitLength(n) : n < 4294967296 ? 32 - Math.clz32(n) : bitLength(BigInt(n));
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }
}

// ── Argument helpers ────────────────────────────────────────────────────────

function index(v: PyValue): PyInt {
  if (typeof v === 'number' || typeof v === 'bigint') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new TypeError(`'${typeName(v)}' object cannot be interpreted as an integer`);
}

function float(v: PyValue): number {
  if (!isNum(v)) throw new TypeError(`must be real number, not ${typeName(v)}`);
  return toFloat(v);
}

function arg(args: PyValue[], kwargs: Kwargs, at: number, name: string): PyValue | undefined {
  return at < args.length ? args[at] : kwargs?.get(name);
}

function rejectUnknown(name: string, kwargs: Kwargs, allowed: string[]): void {
  for (const key of kwargs?.keys() ?? []) {
    if (!allowed.includes(key)) throw new TypeError(`${name}() got an unexpected keyword argument '${key}'`);
  }
}

function atMost(name: string, args: PyValue[], max: number): void {
  if (args.length > max) throw new TypeError(`${name}() takes at most ${max} positional argument${max === 1 ? '' : 's'} (${args.length} given)`);
}

/** `len(seq)` for the sequence types `choice` and `sample` accept. */
function sequenceLength(v: PyValue): number {
  if (v instanceof PyList || v instanceof PyTuple) return v.items.length;
  if (typeof v === 'string') return strLength(v);
  if (v instanceof PyRange) return v.length;
  if (v instanceof PyDict) return v.map.size;
  throw new TypeError(`object of type '${typeName(v)}' has no len()`);
}

function isSequence(v: PyValue): boolean {
  return v instanceof PyList || v instanceof PyTuple || typeof v === 'string' || v instanceof PyRange;
}

/** Insertion point after any entries equal to `x`, like bisect.bisect_right. */
function bisectRight(items: PyValue[], x: number, lo: number, hi: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const w = items[mid];
    if (!isNum(w)) throw new TypeError(`'<' not supported between instances of 'float' and '${typeName(w)}'`);
    if (numCompare(x, w) < 0) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function runningTotals(rt: Runtime, weights: PyValue): MA<PyValue[]> {
  return andThen(rt.collect(weights), (items) => {
    const out: PyValue[] = [];
    let total: PyValue | undefined;
    for (const w of items) {
      if (total === undefined) total = w;
      else {
        if (!isNum(total) || !isNum(w)) throw new TypeError(`unsupported operand type(s) for +: '${typeName(total)}' and '${typeName(w)}'`);
        total = numBinary('+', total, w)!;
      }
      out.push(total);
    }
    return out;
  });
}

// ── The module functions, bound to one generator ────────────────────────────

function makeApi(gen: MersenneTwister): Map<string, PyValue> {
  const seed = (a: PyValue | undefined): void => {
    if (a === undefined || a === null) gen.seedFromEntropy();
    else if (isIntLike(a)) gen.seedFromInt(BigInt(a));
    else throw new TypeError(`The only supported seed types are None and int, not ${typeName(a)}`);
  };

  const randrange = (name: string, args: PyValue[]): PyValue => {
    const start = index(args[0]);
    if (args.length === 1) {
      if (start > 0) return gen.randbelow(start);
      throw new ValueError('empty range for randrange()');
    }
    const stop = index(args[1]);
    const width = intSub(stop, start);
    const step = args.length > 2 ? index(args[2]) : 1;
    if (step === 1) {
      if (width > 0) return intAdd(start, gen.randbelow(width));
      throw new ValueError(`empty range in ${name}(${args.map((a) => pyStr(a)).join(', ')})`);
    }
    if (step === 0) throw new ValueError('zero step for randrange()');
    const n = step > 0 ? intFloorDiv(intSub(intAdd(width, step), 1), step) : intFloorDiv(intAdd(intAdd(width, step), 1), step);
    if (n <= 0) throw new ValueError(`empty range in randrange(${args.map((a) => pyStr(a)).join(', ')})`);
    return intAdd(start, intMul(step, gen.randbelow(n)));
  };

  const fn = (name: string, impl: (rt: Runtime, args: PyValue[], kwargs: Kwargs) => MA<PyValue>, kw = false): [string, PyValue] =>
    [name, new PyBuiltin(name, impl, kw)];

  return new Map<string, PyValue>([
    fn('seed', (_rt, args, kwargs) => {
      atMost('seed', args, 2);
      rejectUnknown('seed', kwargs, ['a', 'version']);
      seed(arg(args, kwargs, 0, 'a'));
      return null;
    }, true),
    fn('random', (_rt, args) => {
      atMost('random', args, 0);
      return new PyFloat(gen.random());
    }),
    fn('getrandbits', (_rt, args) => {
      if (args.length !== 1) throw new TypeError(`getrandbits() takes exactly one argument (${args.length} given)`);
      const k = index(args[0]);
      if (k < 0) throw new ValueError('Cannot convert negative int');
      if (typeof k === 'bigint') throw new ValueError('number of bits too large');
      return gen.getrandbits(k);
    }),
    fn('randrange', (_rt, args, kwargs) => {
      atMost('randrange', args, 3);
      rejectUnknown('randrange', kwargs, ['start', 'stop', 'step']);
      const start = arg(args, kwargs, 0, 'start');
      if (start === undefined) throw new TypeError("randrange() missing 1 required positional argument: 'start'");
      const stop = arg(args, kwargs, 1, 'stop');
      const step = arg(args, kwargs, 2, 'step');
      if (stop === undefined || stop === null) {
        if (step !== undefined && step !== 1) throw new TypeError('Missing a non-None stop argument');
        return randrange('randrange', [start]);
      }
      return randrange('randrange', step === undefined ? [start, stop] : [start, stop, step]);
    }, true),
    fn('randint', (_rt, args, kwargs) => {
      atMost('randint', args, 2);
      rejectUnknown('randint', kwargs, ['a', 'b']);
      const a = arg(args, kwargs, 0, 'a');
      const b = arg(args, kwargs, 1, 'b');
      if (a === undefined || b === undefined) throw new TypeError("randint() missing required argument");
      const lo = index(a);
      const hi = intAdd(index(b), 1);
      const width = intSub(hi, lo);
      if (width > 0) return intAdd(lo, gen.randbelow(width));
      throw new ValueError(`empty range in randint(${pyStr(a)}, ${pyStr(b)})`);
    }, true),
    fn('choice', (rt, args) => {
      if (args.length !== 1) throw new TypeError(`choice() takes exactly one argument (${args.length} given)`);
      const seq = args[0];
      const n = sequenceLength(seq);
      if (n === 0) throw new IndexError('Cannot choose from an empty sequence');
      return getItem(seq, gen.randbelow(n), rt);
    }),
    fn('shuffle', (_rt, args) => {
      if (args.length !== 1) throw new TypeError(`shuffle() takes exactly one argument (${args.length} given)`);
      const x = args[0];
      if (!(x instanceof PyList)) {
        sequenceLength(x);
        throw new TypeError(`'${typeName(x)}' object does not support item assignment`);
      }
      const items = x.items;
      for (let i = items.length - 1; i > 0; i--) {
        const j = gen.randbelow(i + 1) as number;
        const tmp = items[i];
        items[i] = items[j];
        items[j] = tmp;
      }
      return null;
    }),
    fn('sample', (rt, args, kwargs) => {
      atMost('sample', args, 2);
      rejectUnknown('sample', kwargs, ['k', 'counts']);
      const population = args[0];
      const kArg = arg(args, kwargs, 1, 'k');
      if (population === undefined || kArg === undefined) throw new TypeError("sample() missing required argument 'k'");
      if (!isSequence(population)) throw new TypeError('Population must be a sequence.  For dicts or sets, use sorted(d).');
      const n = sequenceLength(population);
      if (!isIntLike(kArg)) throw new TypeError(`can't multiply sequence by non-int of type '${typeName(kArg)}'`);
      const k = Number(kArg);
      const counts = kwargs?.get('counts') ?? null;
      const at = (i: PyInt): PyValue => getItem(population, i) as PyValue;

      const sampleIndices = (size: PyInt, choose: number): PyInt[] => {
        if (!(choose >= 0 && choose <= size)) throw new ValueError('Sample larger than population or is negative');
        const result: PyInt[] = new Array(choose);
        // Small populations use a shrinking pool; large ones reject repeats,
        // with CPython's threshold so the draws line up.
        let setsize = 21;
        if (choose > 5) setsize += 4 ** Math.ceil(Math.log(choose * 3) / Math.log(4));
        if (size <= setsize) {
          const pool: PyInt[] = [];
          for (let i = 0; i < Number(size); i++) pool.push(i);
          for (let i = 0; i < choose; i++) {
            const j = gen.randbelow(Number(size) - i) as number;
            result[i] = pool[j];
            pool[j] = pool[Number(size) - i - 1];
          }
        } else {
          const selected = new Set<PyInt>();
          for (let i = 0; i < choose; i++) {
            let j = gen.randbelow(size);
            while (selected.has(j)) j = gen.randbelow(size);
            selected.add(j);
            result[i] = j;
          }
        }
        return result;
      };

      if (counts === null) return new PyList(sampleIndices(n, k).map(at));
      return andThen(runningTotals(rt, counts), (cumCounts) => {
        if (cumCounts.length !== n) throw new ValueError('The number of counts does not match the population');
        const last = cumCounts.pop()!;
        if (!isIntLike(last)) throw new TypeError('Counts must be integers');
        const total = index(last);
        if (total <= 0) throw new ValueError('Total of counts must be greater than zero');
        const chosen = sampleIndices(total, k);
        return new PyList(chosen.map((s) => at(bisectRight(cumCounts, Number(s), 0, cumCounts.length))));
      });
    }, true),
    fn('choices', (rt, args, kwargs) => {
      atMost('choices', args, 2);
      rejectUnknown('choices', kwargs, ['weights', 'cum_weights', 'k']);
      const population = args[0];
      if (population === undefined) throw new TypeError("choices() missing 1 required positional argument: 'population'");
      const n = sequenceLength(population);
      const weights = arg(args, kwargs, 1, 'weights') ?? null;
      const cumWeights = kwargs?.get('cum_weights') ?? null;
      const kArg = kwargs?.get('k') ?? 1;
      if (!isIntLike(kArg)) throw new TypeError(`'${typeName(kArg)}' object cannot be interpreted as an integer`);
      const k = Number(kArg);
      const draw = (pick: () => PyValue): PyValue => {
        const out: PyValue[] = [];
        for (let i = 0; i < k; i++) out.push(pick());
        return new PyList(out);
      };
      if (cumWeights === null && weights === null) {
        return draw(() => getItem(population, Math.floor(gen.random() * n)) as PyValue);
      }
      if (cumWeights !== null && weights !== null) throw new TypeError('Cannot specify both weights and cumulative weights');
      return andThen(cumWeights !== null ? rt.collect(cumWeights) : runningTotals(rt, weights!), (totals) => {
        if (totals.length !== n) throw new ValueError('The number of weights does not match the population');
        const last = totals[totals.length - 1];
        if (!isNum(last)) throw new TypeError(`unsupported operand type(s) for +: '${typeName(last)}' and 'float'`);
        const total = toFloat(last);
        if (total <= 0) throw new ValueError('Total of weights must be greater than zero');
        if (!Number.isFinite(total)) throw new ValueError('Total of weights must be finite');
        return draw(() => getItem(population, bisectRight(totals, gen.random() * total, 0, n - 1)) as PyValue);
      });
    }, true),
    fn('uniform', (_rt, args, kwargs) => {
      atMost('uniform', args, 2);
      rejectUnknown('uniform', kwargs, ['a', 'b']);
      const a = arg(args, kwargs, 0, 'a');
      const b = arg(args, kwargs, 1, 'b');
      if (a === undefined || b === undefined) throw new TypeError('uniform() missing required argument');
      if (!isNum(a) || !isNum(b)) throw new TypeError(`unsupported operand type(s) for -: '${typeName(b)}' and '${typeName(a)}'`);
      const x = toFloat(a);
      return new PyFloat(x + (toFloat(b) - x) * gen.random());
    }, true),
    fn('triangular', (_rt, args, kwargs) => {
      atMost('triangular', args, 3);
      rejectUnknown('triangular', kwargs, ['low', 'high', 'mode']);
      const lowArg = arg(args, kwargs, 0, 'low') ?? new PyFloat(0);
      let low = float(lowArg);
      let high = float(arg(args, kwargs, 1, 'high') ?? new PyFloat(1));
      const mode = arg(args, kwargs, 2, 'mode') ?? null;
      let u = gen.random();
      // CPython returns `low` as passed when the mode division hits zero.
      if (mode !== null && high === low) return lowArg;
      let c = mode === null ? 0.5 : (float(mode) - low) / (high - low);
      if (u > c) {
        u = 1 - u;
        c = 1 - c;
        [low, high] = [high, low];
      }
      return new PyFloat(low + (high - low) * Math.sqrt(u * c));
    }, true),
    fn('gauss', (_rt, args, kwargs) => {
      atMost('gauss', args, 2);
      rejectUnknown('gauss', kwargs, ['mu', 'sigma']);
      const mu = float(arg(args, kwargs, 0, 'mu') ?? new PyFloat(0));
      const sigma = float(arg(args, kwargs, 1, 'sigma') ?? new PyFloat(1));
      // Box-Muller yields two variates; the second is kept for the next call.
      let z = gen.gaussNext;
      gen.gaussNext = null;
      if (z === null) {
        const x2pi = gen.random() * Math.PI * 2;
        const g2rad = Math.sqrt(-2 * Math.log(1 - gen.random()));
        z = Math.cos(x2pi) * g2rad;
        gen.gaussNext = Math.sin(x2pi) * g2rad;
      }
      return new PyFloat(mu + z * sigma);
    }, true),
    fn('normalvariate', (_rt, args, kwargs) => {
      atMost('normalvariate', args, 2);
      rejectUnknown('normalvariate', kwargs, ['mu', 'sigma']);
      const mu = float(arg(args, kwargs, 0, 'mu') ?? new PyFloat(0));
      const sigma = float(arg(args, kwargs, 1, 'sigma') ?? new PyFloat(1));
      const magic = 4 * Math.exp(-0.5) / Math.sqrt(2);
      let z: number;
      for (;;) {
        const u1 = gen.random();
        const u2 = 1 - gen.random();
        z = magic * (u1 - 0.5) / u2;
        if ((z * z) / 4 <= -Math.log(u2)) break;
      }
      return new PyFloat(mu + z * sigma);
    }, true),
    fn('expovariate', (_rt, args, kwargs) => {
      atMost('expovariate', args, 1);
      rejectUnknown('expovariate', kwargs, ['lambd']);
      const lambd = float(arg(args, kwargs, 0, 'lambd') ?? new PyFloat(1));
      return new PyFloat(-Math.log(1 - gen.random()) / lambd);
    }, true),
  ]);
}

// ── random.Random instances ─────────────────────────────────────────────────

class PyRandom extends PyObject {
  readonly typeName = 'random.Random';
  constructor(private readonly api: Map<string, PyValue>) {
    super();
  }
  getAttr(name: string): PyValue | undefined {
    return this.api.get(name);
  }
}

const T_RANDOM = namedType('random.Random');
T_RANDOM.construct = (_rt, args, kwargs) => {
  atMost('Random', args, 1);
  if (kwargs !== null && kwargs.size > 0) throw new TypeError('Random() takes no keyword arguments');
  const gen = new MersenneTwister();
  const api = makeApi(gen);
  (api.get('seed') as PyBuiltin).fn(_rt, args, null);
  return new PyRandom(api);
};

/** A module with its own generator, seeded from OS entropy. */
export function createRandom(): PyModule {
  const gen = new MersenneTwister();
  gen.seedFromEntropy();
  const attrs = makeApi(gen);
  attrs.set('Random', T_RANDOM);
  return new PyModule('random', attrs, createRandom);
}

export const random: PyModule = createRandom();
