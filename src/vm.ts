/**
 * Bytecode virtual machine.
 *
 * A Python call pushes a Frame and the same loop keeps going, so a tool call
 * can pause the whole script on a promise and recursion ends in a catchable
 * RecursionError. Only a built-in that calls back into Python (a sort key,
 * `map`, consuming a generator) nests a second loop, to a bounded depth.
 */

import type { Code, FunctionProto } from './compiler';
import {
  AssertionError, AttributeError, CancelledError, ImportError, InterpreterError, MaxIterationsError, MemoryError,
  ModuleNotFoundError, NameError, RecursionError, RuntimeError, TimeoutError, TypeError,
  UnboundLocalError, ValueError, isUncatchable,
} from './errors';
import { UNSUPPORTED_BUILTINS } from './builtins';
import { asciiRepr, formatValue } from './format';
import { findMethod, getAttribute } from './methods';
import { binary, compare, deleteItem, getItem, inplace, setItem, unary } from './ops';
import {
  Cell, DONE, Done, Globals, HashIterator, Kwargs, MA, PyBuiltin, PyDict, PyDictView, PyFunction, PyGenerator,
  PyIterator, PyList, PyModule, PyObject, PyRange, PySet, PySlice, PyTuple, PyType, PyValue, RangeIterator,
  Runtime, SeqIterator,
  copyDict, copySet, dictHas, dictKeys, dictSet, pyRepr, pySetFrom, pyStr, setAdd, strChars, truthy, typeName,
} from './values';

export const enum Op {
  POP, DUP, DUP2, ROT2, ROT3,
  LOAD_CONST, LOAD_FAST, STORE_FAST, DELETE_FAST,
  LOAD_DEREF, STORE_DEREF, DELETE_DEREF,
  LOAD_GLOBAL, STORE_GLOBAL, DELETE_GLOBAL,
  LOAD_ATTR, STORE_ATTR,
  BINARY, INPLACE, UNARY, COMPARE,
  SUBSCR, STORE_SUBSCR, DELETE_SUBSCR, BUILD_SLICE,
  BUILD_LIST, BUILD_TUPLE, BUILD_SET, BUILD_MAP, BUILD_STRING,
  LIST_APPEND, SET_ADD, MAP_ADD, LIST_EXTEND, DICT_MERGE, LIST_TO_TUPLE, LIST_TO_SET,
  FORMAT_VALUE,
  JUMP, JUMP_LOOP, POP_JUMP_IF_FALSE, POP_JUMP_IF_TRUE, JUMP_IF_FALSE_OR_POP, JUMP_IF_TRUE_OR_POP,
  GET_ITER, FOR_ITER,
  UNPACK_SEQUENCE, UNPACK_EX,
  KW_NAMES, CALL, CALL_METHOD, CALL_EX,
  MAKE_FUNCTION, RETURN, YIELD, YIELD_FROM_RESULT,
  RAISE, RERAISE, RERAISE_NONE, RAISE_ASSERT, EXC_MATCH,
  IMPORT_NAME, IMPORT_FROM, IMPORT_STAR,
  STORE_RESULT, CLEAR_RESULT, LOAD_RESULT,
}

export const enum BinOp { ADD, SUB, MUL, DIV, FLOORDIV, MOD, POW, AND, OR, XOR, LSHIFT, RSHIFT }
export const enum CmpOp { EQ, NE, LT, GT, LE, GE, IN, NOT_IN, IS, IS_NOT }
export const enum UnOp { NEG, POS, NOT, INVERT }

/** What to do with the value a suspended instruction was waiting for. */
const enum Await {
  /** Push it and carry on. */
  PUSH,
  /** Nothing to push (a store finished). */
  DISCARD,
  /** FOR_ITER: push the item, or leave the loop when the iterator is done. */
  FOR_ITER,
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
/** Nested Python calls allowed, like CPython's recursion limit. */
const MAX_DEPTH = 1000;
/** Built-ins calling back into Python (lru_cache, sorted key=) may nest this
 *  deep. Each level costs JS stack; Node's default stack holds about 680. */
const MAX_NESTING = 500;
const NO_CELLS: Cell[] = [];
const NO_VALUES: PyValue[] = [];
/** Returned by `invoke` when it pushed a Python frame instead of producing a value. */
const PUSHED = Symbol('PUSHED');

export class Frame {
  pc = 0;
  sp = 0;
  readonly stack: any[] = [];
  readonly locals: (PyValue | undefined)[];
  readonly cells: Cell[];
  /** Set when this frame is the body of a generator. */
  gen: PyGenerator | null = null;
  /** True while a `for` loop in the frame below is driving this generator. */
  inline = false;
  /** Module frames: value of the last expression statement. */
  result: PyValue = null;

  constructor(public readonly code: Code, closure: Cell[] | null) {
    this.locals = new Array(code.varNames.length);
    if (code.cellNames.length === 0) {
      this.cells = NO_CELLS;
    } else {
      this.cells = [];
      for (let i = 0; i < code.ownCells; i++) this.cells.push(new Cell());
      if (closure) for (const cell of closure) this.cells.push(cell);
    }
  }
}

/** Interpreter state a VM runs against; it outlives a single run(). */
export interface VMHost {
  globals: Globals;
  builtins: Map<string, PyValue>;
  modules: Map<string, PyModule>;
  maxIterations: number;
  timeoutMs: number | undefined;
  maxStringLength: number;
  maxCollectionSize: number;
}

/** List, dict and set defaults are copied per call, so a mutable default
 *  never leaks state between calls (a documented deviation from CPython). */
function freshDefault(v: PyValue): PyValue {
  if (v instanceof PyList) return new PyList(v.items.slice());
  if (v instanceof PyDict) return copyDict(v);
  if (v instanceof PySet) return copySet(v);
  return v;
}

/** JS reports both runaway native recursion and oversized allocations as
 *  RangeError; scripts see the Python exception for each. */
export function fromRangeError(error: RangeError): RecursionError | MemoryError {
  // No regex here: this can run with almost no JS stack left.
  const message = error.message;
  return message.includes('call stack') || message.includes('recursion')
    ? new RecursionError('maximum recursion depth exceeded')
    : new MemoryError(`result is too large (${message})`);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function quoteList(names: string[]): string {
  const quoted = names.map((n) => `'${n}'`);
  if (quoted.length <= 2) return quoted.join(' and ');
  return `${quoted.slice(0, -1).join(', ')}, and ${quoted[quoted.length - 1]}`;
}

export class VM implements Runtime {
  private readonly frames: Frame[] = [];
  private readonly builtins: Map<string, PyValue>;
  /** Frames that count toward the recursion limit (comprehensions do not). */
  private depth = 0;
  /** How many built-ins are currently waiting on Python code they called. */
  private nesting = 0;
  private loopTicks = 0;
  private callTicks = 0;
  private readonly deadline: number;
  /** True when there is a deadline or a signal to poll at all. */
  private readonly watched: boolean;
  /** When the script last gave the event loop a turn; only used with a signal. */
  private lastYield = Date.now();

  constructor(private readonly host: VMHost, private readonly signal: AbortSignal | null = null) {
    this.builtins = host.builtins;
    this.deadline = host.timeoutMs !== undefined ? Date.now() + host.timeoutMs : Infinity;
    this.watched = this.deadline !== Infinity || signal !== null;
  }

  /** Runs module code to completion and returns its result value. */
  runModule(code: Code): MA<PyValue> {
    this.frames.push(new Frame(code, null));
    return this.run(0) as MA<PyValue>;
  }

  // ── Runtime interface (used by built-ins) ─────────────────────────────────

  call(fn: PyValue, args: PyValue[], kwargs: Kwargs = null): MA<PyValue> {
    if (fn instanceof PyFunction && !fn.code.isGenerator) this.checkNesting();
    const r = this.invoke(fn, args, kwargs);
    if (r === PUSHED) return this.runNested() as MA<PyValue>;
    return r as MA<PyValue>;
  }

  iter(v: PyValue): PyValue {
    if (v instanceof PyList) return new SeqIterator(v.items);
    if (v instanceof PyTuple) return new SeqIterator(v.items, 'tuple_iterator');
    if (v instanceof PyRange) return new RangeIterator(v);
    if (typeof v === 'string') return new SeqIterator(strChars(v), 'str_iterator');
    if (v instanceof PyDict) return new HashIterator(v, dictKeys(v), 'dict_keyiterator');
    if (v instanceof PySet) return new HashIterator(v, Array.from(v.map.values()), 'set_iterator');
    if (v instanceof PyDictView) return new HashIterator(v.dict, v.toArray(), `dict_${v.kind.slice(0, -1)}iterator`);
    if (v instanceof PyGenerator || v instanceof PyIterator) return v;
    if (v instanceof PyObject) {
      const items = v.iterate();
      if (items !== undefined) return new SeqIterator(items, `${v.typeName}_iterator`);
    }
    throw new TypeError(`'${typeName(v)}' object is not iterable`);
  }

  next(it: PyValue): MA<PyValue | Done> {
    if (it instanceof PyGenerator) return this.resume(it, null);
    if (it instanceof PyIterator) return it.next(this);
    throw new TypeError(`'${typeName(it)}' object is not an iterator`);
  }

  forEach(iterable: PyValue, visit: (item: PyValue) => boolean | void): MA<void> {
    if (iterable instanceof PyList || iterable instanceof PyTuple) {
      const items = iterable.items;
      this.checkpoint(items.length);
      for (let i = 0; i < items.length; i++) if (visit(items[i])) return;
      return;
    }
    // A built-in may walk a lazy iterable only up to the collection limit;
    // loops written in Python are bounded by maxIterations instead.
    if (iterable instanceof PyRange) this.checkCollection(iterable.length);
    const it = this.iter(iterable);
    for (let count = 1; ; count++) {
      const r = this.next(it);
      if (r instanceof Promise) return this.forEachAsync(it, visit, r, count);
      if (r === DONE || visit(r)) return;
      if ((count & 1023) === 0) this.checkpoint(count);
    }
  }

  private async forEachAsync(
    it: PyValue, visit: (item: PyValue) => boolean | void, pending: Promise<PyValue | Done>, count: number,
  ): Promise<void> {
    let r = await pending;
    while (r !== DONE && !visit(r)) {
      if ((++count & 1023) === 0) this.checkpoint(count);
      const n = this.next(it);
      r = n instanceof Promise ? await n : n;
    }
  }

  collect(iterable: PyValue): MA<PyValue[]> {
    if (iterable instanceof PyList || iterable instanceof PyTuple) {
      this.checkpoint(iterable.items.length);
      return iterable.items;
    }
    const out: PyValue[] = [];
    const r = this.forEach(iterable, (item) => { out.push(item); });
    return r instanceof Promise ? r.then(() => out) : out;
  }

  checkString(length: number): void {
    if (length > this.host.maxStringLength) {
      throw new MemoryError(`result exceeds the maximum string length (${this.host.maxStringLength} characters)`);
    }
  }

  checkCollection(size: number): void {
    if (size > this.host.maxCollectionSize) {
      throw new MemoryError(`result exceeds the maximum collection size (${this.host.maxCollectionSize} elements)`);
    }
  }

  /** A built-in is about to do work proportional to `size`: enforce the
   *  collection limit, and the deadline when the work is large. */
  private checkpoint(size: number): void {
    this.checkCollection(size);
    if (size >= 1024 && this.watched) this.checkDeadline();
  }

  // ── Generators ────────────────────────────────────────────────────────────

  /** Runs a generator until its next yield; DONE when it returns. */
  resume(gen: PyGenerator, sent: PyValue): MA<PyValue | Done> {
    if (gen.state === 'done') return DONE;
    if (gen.state === 'running') throw new ValueError('generator already executing');
    const frame = gen.frame!;
    if (gen.state === 'created' && sent !== null) {
      throw new TypeError("can't send non-None value to a just-started generator");
    }
    this.checkNesting();
    this.enterGenerator(gen, frame, sent);
    return this.runNested();
  }

  private enterGenerator(gen: PyGenerator, frame: Frame, sent: PyValue): void {
    this.pushFrame(frame);
    // The value sent in becomes the result of the yield the generator is paused on.
    if (gen.state === 'suspended') frame.stack[frame.sp++] = sent;
    gen.state = 'running';
  }

  private checkNesting(): void {
    if (this.nesting >= MAX_NESTING) throw new RecursionError('maximum recursion depth exceeded');
  }

  /** Runs the frame just pushed in its own loop, on behalf of a built-in. */
  private runNested(): MA<PyValue | Done> {
    this.nesting++;
    let r: MA<PyValue | Done>;
    try {
      r = this.run(this.frames.length - 1);
    } catch (error) {
      this.nesting--;
      throw error;
    }
    if (r instanceof Promise) return r.finally(() => { this.nesting--; });
    this.nesting--;
    return r;
  }

  // ── Calls ─────────────────────────────────────────────────────────────────

  private pushFrame(frame: Frame): void {
    const counted = !frame.code.isComprehension;
    if (counted && this.depth >= MAX_DEPTH) throw new RecursionError('maximum recursion depth exceeded');
    if (++this.callTicks > this.host.maxIterations) throw new MaxIterationsError();
    if ((this.callTicks & 8191) === 0) this.checkDeadline();
    if (counted) this.depth++;
    this.frames.push(frame);
  }

  private popFrame(frame: Frame): void {
    this.frames.pop();
    if (!frame.code.isComprehension) this.depth--;
  }

  private tickLoop(): void {
    if (++this.loopTicks > this.host.maxIterations) throw new MaxIterationsError();
    if ((this.loopTicks & 8191) === 0) this.checkDeadline();
  }

  private yieldToHost(): Promise<void> {
    return new Promise((resolve) => setTimeout(() => {
      this.lastYield = Date.now();
      resolve();
    }, 0));
  }

  private checkDeadline(): void {
    if (!this.watched) return;
    if (Date.now() > this.deadline) throw new TimeoutError(this.host.timeoutMs!);
    if (this.signal !== null && this.signal.aborted) throw new CancelledError(this.signal.reason);
  }

  /** Calls `callee`. For a Python function this pushes its frame and
   *  returns PUSHED; anything else returns its value or a promise for it. */
  private invoke(callee: PyValue, args: PyValue[], kwargs: Kwargs): MA<PyValue> | typeof PUSHED {
    if (callee instanceof PyFunction) {
      const frame = new Frame(callee.code, callee.closure);
      this.bindArguments(callee, frame, args, kwargs);
      if (callee.code.isGenerator) {
        const gen = new PyGenerator(callee.name, frame);
        frame.gen = gen;
        return gen;
      }
      this.pushFrame(frame);
      return PUSHED;
    }
    if (callee instanceof PyBuiltin) {
      if (kwargs !== null && !callee.kw) {
        if (kwargs.size > 0) throw new TypeError(`${callee.name}() takes no keyword arguments`);
        kwargs = null;
      }
      return callee.fn(this, args, kwargs);
    }
    if (callee instanceof PyType) {
      if (!callee.construct) throw new TypeError(`cannot create '${callee.qualName}' instances`);
      return callee.construct(this, args, kwargs);
    }
    throw new TypeError(`'${typeName(callee)}' object is not callable`);
  }

  /** The common call: `argc` positional arguments go straight from the
   *  caller's stack (starting at `first`) into the new frame's locals. */
  private enterSimple(fn: PyFunction, stack: any[], first: number, argc: number): void {
    const code = fn.code;
    const callee = new Frame(code, fn.closure);
    const locals = callee.locals;
    for (let i = 0; i < argc; i++) locals[i] = stack[first + i];
    const defaults = fn.defaults;
    const firstDefault = code.argCount - defaults.length;
    for (let i = argc; i < code.argCount; i++) locals[i] = freshDefault(defaults[i - firstDefault]);
    const cellParams = code.cellParams;
    for (let i = 0; i < cellParams.length; i += 2) callee.cells[cellParams[i + 1]].v = locals[cellParams[i]];
    this.pushFrame(callee);
  }

  private bindArguments(fn: PyFunction, frame: Frame, args: PyValue[], kwargs: Kwargs): void {
    const code = fn.code;
    const locals = frame.locals;
    const argCount = code.argCount;
    const paramCount = argCount + code.kwOnlyCount;
    const given = args.length;

    const positional = given < argCount ? given : argCount;
    for (let i = 0; i < positional; i++) locals[i] = args[i];

    if (code.hasVarArgs) {
      locals[paramCount] = new PyTuple(given > argCount ? args.slice(argCount) : []);
    } else if (given > argCount) {
      const required = argCount - fn.defaults.length;
      const takes = fn.defaults.length > 0
        ? `from ${required} to ${plural(argCount, 'positional argument')}`
        : plural(argCount, 'positional argument');
      throw new TypeError(`${fn.name}() takes ${takes} but ${given} ${given === 1 ? 'was' : 'were'} given`);
    }

    let extra: PyDict | null = null;
    if (code.hasKwargs) {
      extra = new PyDict();
      locals[paramCount + (code.hasVarArgs ? 1 : 0)] = extra;
    }
    if (kwargs !== null) {
      for (const [name, value] of kwargs) {
        let slot = -1;
        for (let i = 0; i < paramCount; i++) {
          if (code.varNames[i] === name) { slot = i; break; }
        }
        if (slot >= 0) {
          if (locals[slot] !== undefined) throw new TypeError(`${fn.name}() got multiple values for argument '${name}'`);
          locals[slot] = value;
        } else if (extra) {
          dictSet(extra, name, value);
        } else {
          throw new TypeError(`${fn.name}() got an unexpected keyword argument '${name}'`);
        }
      }
    }

    if (positional < argCount) {
      const defaults = fn.defaults;
      const firstDefault = argCount - defaults.length;
      let missing: string[] | null = null;
      for (let i = positional; i < argCount; i++) {
        if (locals[i] !== undefined) continue;
        if (i >= firstDefault) locals[i] = freshDefault(defaults[i - firstDefault]);
        else (missing ??= []).push(code.varNames[i]);
      }
      if (missing) {
        throw new TypeError(`${fn.name}() missing ${plural(missing.length, 'required positional argument')}: ${quoteList(missing)}`);
      }
    }
    if (code.kwOnlyCount > 0) {
      let missing: string[] | null = null;
      for (let i = argCount; i < paramCount; i++) {
        if (locals[i] !== undefined) continue;
        const value = fn.kwDefaults?.get(code.varNames[i]);
        if (value !== undefined) locals[i] = freshDefault(value);
        else (missing ??= []).push(code.varNames[i]);
      }
      if (missing) {
        throw new TypeError(`${fn.name}() missing ${plural(missing.length, 'required keyword-only argument')}: ${quoteList(missing)}`);
      }
    }

    const cellParams = code.cellParams;
    for (let i = 0; i < cellParams.length; i += 2) frame.cells[cellParams[i + 1]].v = locals[cellParams[i]];
  }

  // ── Execution ─────────────────────────────────────────────────────────────

  /** Runs until only `base` frames remain: the frame on top now has
   *  returned or, for a generator, yielded. */
  private run(base: number): MA<PyValue | Done> {
    const r = this.execute(base);
    if (!(r instanceof Promise)) return r;
    return r.then(
      () => {
        // maxIterations can't bound time spent awaiting a handler.
        if (Date.now() > this.deadline) this.unwind(new TimeoutError(this.host.timeoutMs!), base);
        else if (this.signal !== null && this.signal.aborted) this.unwind(new CancelledError(this.signal.reason), base);
        return this.run(base);
      },
      (error) => {
        this.unwind(error, base);
        return this.run(base);
      },
    );
  }

  /** Points the nearest frame above `base` that handles `error` at its
   *  handler; with none, drops those frames and rethrows. */
  private unwind(error: unknown, base: number): void {
    const frames = this.frames;
    if (error instanceof RangeError) error = fromRangeError(error);
    if (error instanceof InterpreterError && error.line === 0 && frames.length > base) {
      const top = frames[frames.length - 1];
      const at = top.pc > 0 ? top.pc - 1 : 0;
      error.setPosition(top.code.lines[at], top.code.cols[at]);
    }
    const catchable = error instanceof InterpreterError && !isUncatchable(error);
    while (frames.length > base) {
      const frame = frames[frames.length - 1];
      if (catchable) {
        const at = frame.pc - 1;
        const table = frame.code.handlers;
        for (let i = 0; i < table.length; i += 4) {
          if (at >= table[i] && at < table[i + 1]) {
            frame.sp = table[i + 3];
            frame.stack[frame.sp++] = error;
            frame.pc = table[i + 2];
            return;
          }
        }
      }
      if (frame.gen) {
        frame.gen.state = 'done';
        frame.gen.frame = null;
      }
      this.popFrame(frame);
    }
    throw error;
  }

  /** Parks `frame` until `pending` settles, then delivers the value into it
   *  the way `mode` says. The loop resumes once the returned promise does. */
  private wait(frame: Frame, pc: number, sp: number, mode: Await, pending: Promise<any>): Promise<void> {
    frame.pc = pc;
    frame.sp = sp;
    return pending.then((value) => {
      if (mode === Await.PUSH) {
        frame.stack[frame.sp++] = value;
      } else if (mode === Await.FOR_ITER) {
        if (value === DONE) {
          frame.sp--;
          frame.pc = frame.code.args[frame.pc - 1];
        } else {
          this.tickLoop();
          frame.stack[frame.sp++] = value;
        }
      }
    });
  }

  private lookupGlobal(name: string): PyValue {
    const v = this.builtins.get(name);
    if (v !== undefined) return v;
    const hint = Object.hasOwn(UNSUPPORTED_BUILTINS, name) ? ` — ${UNSUPPORTED_BUILTINS[name]}` : '';
    throw new NameError(`name '${name}' is not defined${hint}`);
  }

  /** The instruction loop. Returns a value when `run` is done, or a promise
   *  from `wait` when the script has to pause. */
  private execute(base: number): PyValue | Done | Promise<void> {
    const frames = this.frames;
    const globals = this.host.globals;
    const globalValues = globals.values;
    const maxIterations = this.host.maxIterations;

    reload: for (;;) {
      const frame = frames[frames.length - 1];
      const code = frame.code;
      const ops = code.ops;
      const args = code.args;
      const consts = code.consts;
      const names = code.names;
      const stack = frame.stack;
      const locals = frame.locals;
      let pc = frame.pc;
      let sp = frame.sp;

      try {
        for (;;) {
          const arg = args[pc];
          switch (ops[pc++] as Op) {
            case Op.POP:
              sp--;
              break;
            case Op.DUP:
              stack[sp] = stack[sp - 1];
              sp++;
              break;
            case Op.DUP2:
              stack[sp] = stack[sp - 2];
              stack[sp + 1] = stack[sp - 1];
              sp += 2;
              break;
            case Op.ROT2: {
              const top = stack[sp - 1];
              stack[sp - 1] = stack[sp - 2];
              stack[sp - 2] = top;
              break;
            }
            case Op.ROT3: {
              const top = stack[sp - 1];
              stack[sp - 1] = stack[sp - 2];
              stack[sp - 2] = stack[sp - 3];
              stack[sp - 3] = top;
              break;
            }

            case Op.LOAD_CONST:
              stack[sp++] = consts[arg];
              break;
            case Op.LOAD_FAST: {
              const v = locals[arg];
              if (v === undefined) {
                throw new UnboundLocalError(`cannot access local variable '${code.varNames[arg]}' where it is not associated with a value`);
              }
              stack[sp++] = v;
              break;
            }
            case Op.STORE_FAST:
              locals[arg] = stack[--sp];
              break;
            case Op.DELETE_FAST:
              if (locals[arg] === undefined) {
                throw new UnboundLocalError(`cannot access local variable '${code.varNames[arg]}' where it is not associated with a value`);
              }
              locals[arg] = undefined;
              break;
            case Op.LOAD_DEREF: {
              const v = frame.cells[arg].v;
              if (v === undefined) {
                const name = code.cellNames[arg];
                throw arg < code.ownCells
                  ? new UnboundLocalError(`cannot access local variable '${name}' where it is not associated with a value`)
                  : new NameError(`cannot access free variable '${name}' where it is not associated with a value in enclosing scope`);
              }
              stack[sp++] = v;
              break;
            }
            case Op.STORE_DEREF:
              frame.cells[arg].v = stack[--sp];
              break;
            case Op.DELETE_DEREF:
              frame.cells[arg].v = undefined;
              break;
            case Op.LOAD_GLOBAL: {
              // Not defined by the script: it may be a built-in or a tool.
              const v = globalValues[arg];
              stack[sp++] = v !== undefined ? v : this.lookupGlobal(globals.names[arg]);
              break;
            }
            case Op.STORE_GLOBAL:
              globalValues[arg] = stack[--sp];
              break;
            case Op.DELETE_GLOBAL:
              if (globalValues[arg] === undefined) throw new NameError(`name '${globals.names[arg]}' is not defined`);
              globalValues[arg] = undefined;
              break;

            case Op.LOAD_ATTR:
              stack[sp - 1] = getAttribute(stack[sp - 1], names[arg]);
              break;
            case Op.STORE_ATTR: {
              const obj = stack[--sp];
              sp--;
              throw new AttributeError(`'${typeName(obj)}' object has no attribute '${names[arg]}' and no __dict__ for setting new attributes`);
            }

            case Op.BINARY: {
              const b = stack[--sp];
              const a = stack[sp - 1];
              if (typeof a === 'number' && typeof b === 'number') {
                if (arg === BinOp.ADD) {
                  const r = a + b;
                  if (r <= MAX_SAFE && r >= -MAX_SAFE) { stack[sp - 1] = r; break; }
                } else if (arg === BinOp.SUB) {
                  const r = a - b;
                  if (r <= MAX_SAFE && r >= -MAX_SAFE) { stack[sp - 1] = r; break; }
                } else if (arg === BinOp.MUL) {
                  const r = a * b;
                  if (r <= MAX_SAFE && r >= -MAX_SAFE && r !== 0) { stack[sp - 1] = r; break; }
                }
              }
              stack[sp - 1] = binary(this, arg, a, b);
              break;
            }
            case Op.INPLACE: {
              const b = stack[--sp];
              const a = stack[sp - 1];
              if (typeof a === 'number' && typeof b === 'number') {
                if (arg === BinOp.ADD) {
                  const r = a + b;
                  if (r <= MAX_SAFE && r >= -MAX_SAFE) { stack[sp - 1] = r; break; }
                } else if (arg === BinOp.SUB) {
                  const r = a - b;
                  if (r <= MAX_SAFE && r >= -MAX_SAFE) { stack[sp - 1] = r; break; }
                }
              }
              const r = inplace(this, arg, a, b);
              if (r instanceof Promise) return this.wait(frame, pc, sp - 1, Await.PUSH, r);
              stack[sp - 1] = r;
              break;
            }
            case Op.UNARY: {
              const v = stack[sp - 1];
              stack[sp - 1] = arg === UnOp.NOT ? !truthy(v) : unary(arg, v);
              break;
            }
            case Op.COMPARE: {
              const b = stack[--sp];
              const a = stack[sp - 1];
              if (typeof a === 'number' && typeof b === 'number') {
                switch (arg as CmpOp) {
                  case CmpOp.EQ: stack[sp - 1] = a === b; continue;
                  case CmpOp.NE: stack[sp - 1] = a !== b; continue;
                  case CmpOp.LT: stack[sp - 1] = a < b; continue;
                  case CmpOp.GT: stack[sp - 1] = a > b; continue;
                  case CmpOp.LE: stack[sp - 1] = a <= b; continue;
                  case CmpOp.GE: stack[sp - 1] = a >= b; continue;
                }
              }
              const r = compare(this, arg, a, b);
              if (r instanceof Promise) return this.wait(frame, pc, sp - 1, Await.PUSH, r);
              stack[sp - 1] = r;
              break;
            }

            case Op.SUBSCR: {
              const index = stack[--sp];
              const obj = stack[sp - 1];
              if (typeof index === 'number' && obj instanceof PyList && index >= 0 && index < obj.items.length) {
                stack[sp - 1] = obj.items[index];
              } else {
                const r = getItem(obj, index, this);
                if (r instanceof Promise) return this.wait(frame, pc, sp - 1, Await.PUSH, r);
                stack[sp - 1] = r;
              }
              break;
            }
            case Op.STORE_SUBSCR: {
              const index = stack[--sp];
              const obj = stack[--sp];
              const value = stack[--sp];
              const r = setItem(this, obj, index, value);
              if (r instanceof Promise) return this.wait(frame, pc, sp, Await.DISCARD, r as Promise<any>);
              break;
            }
            case Op.DELETE_SUBSCR: {
              const index = stack[--sp];
              deleteItem(stack[--sp], index);
              break;
            }
            case Op.BUILD_SLICE: {
              const step = arg === 3 ? stack[--sp] : null;
              const stop = stack[--sp];
              stack[sp - 1] = new PySlice(stack[sp - 1], stop, step);
              break;
            }

            case Op.BUILD_LIST:
              sp -= arg;
              stack[sp] = new PyList(arg === 0 ? [] : stack.slice(sp, sp + arg));
              sp++;
              break;
            case Op.BUILD_TUPLE:
              sp -= arg;
              stack[sp] = new PyTuple(arg === 0 ? [] : stack.slice(sp, sp + arg));
              sp++;
              break;
            case Op.BUILD_SET: {
              sp -= arg;
              const set = new PySet();
              for (let i = 0; i < arg; i++) setAdd(set, stack[sp + i]);
              stack[sp++] = set;
              break;
            }
            case Op.BUILD_MAP:
              stack[sp++] = new PyDict();
              break;
            case Op.BUILD_STRING: {
              sp -= arg;
              let s = '';
              for (let i = 0; i < arg; i++) s += stack[sp + i];
              this.checkString(s.length);
              stack[sp++] = s;
              break;
            }
            case Op.LIST_APPEND: {
              const v = stack[--sp];
              (stack[sp - arg] as PyList).items.push(v);
              break;
            }
            case Op.SET_ADD: {
              const v = stack[--sp];
              setAdd(stack[sp - arg] as PySet, v);
              break;
            }
            case Op.MAP_ADD: {
              const v = stack[--sp];
              const k = stack[--sp];
              dictSet(stack[sp - arg] as PyDict, k, v);
              break;
            }
            case Op.LIST_EXTEND: {
              const iterable = stack[--sp];
              const list = stack[sp - 1] as PyList;
              const r = this.collect(iterable);
              if (r instanceof Promise) {
                return this.wait(frame, pc, sp, Await.DISCARD, r.then((items) => {
                  for (const item of items) list.items.push(item);
                  return null;
                }));
              }
              for (const item of r) list.items.push(item);
              break;
            }
            case Op.DICT_MERGE: {
              const mapping = stack[--sp];
              const dict = stack[sp - 1] as PyDict;
              if (!(mapping instanceof PyDict)) {
                throw new TypeError(arg === 1
                  ? `argument after ** must be a mapping, not ${typeName(mapping)}`
                  : `'${typeName(mapping)}' object is not a mapping`);
              }
              for (const entry of mapping.map.values()) {
                if (arg === 1) {
                  if (typeof entry[0] !== 'string') throw new TypeError('keywords must be strings');
                  if (dictHas(dict, entry[0])) {
                    throw new TypeError(`got multiple values for keyword argument '${entry[0]}'`);
                  }
                }
                dictSet(dict, entry[0], entry[1]);
              }
              break;
            }
            case Op.LIST_TO_TUPLE:
              stack[sp - 1] = new PyTuple((stack[sp - 1] as PyList).items);
              break;
            case Op.LIST_TO_SET:
              stack[sp - 1] = pySetFrom((stack[sp - 1] as PyList).items);
              break;

            case Op.FORMAT_VALUE: {
              const spec: string = arg & 4 ? stack[--sp] : '';
              let v = stack[sp - 1];
              const conversion = arg & 3;
              if (conversion === 1) v = pyStr(v);
              else if (conversion === 2) v = pyRepr(v);
              else if (conversion === 3) v = asciiRepr(v);
              stack[sp - 1] = typeof v === 'string' && spec === '' ? v : formatValue(v, spec);
              break;
            }

            case Op.JUMP:
              pc = arg;
              break;
            case Op.JUMP_LOOP:
              if (++this.loopTicks > maxIterations) throw new MaxIterationsError();
              if ((this.loopTicks & 8191) === 0) {
                this.checkDeadline();
                // An abort can only be delivered while the host's event loop
                // runs, so a watched script hands it a turn every 10 ms.
                if (this.signal !== null && Date.now() - this.lastYield >= 10) {
                  return this.wait(frame, arg, sp, Await.DISCARD, this.yieldToHost());
                }
              }
              pc = arg;
              break;
            case Op.POP_JUMP_IF_FALSE: {
              const v = stack[--sp];
              if (v === false || (v !== true && !truthy(v))) pc = arg;
              break;
            }
            case Op.POP_JUMP_IF_TRUE: {
              const v = stack[--sp];
              if (v === true || (v !== false && truthy(v))) pc = arg;
              break;
            }
            case Op.JUMP_IF_FALSE_OR_POP:
              if (truthy(stack[sp - 1])) sp--;
              else pc = arg;
              break;
            case Op.JUMP_IF_TRUE_OR_POP:
              if (truthy(stack[sp - 1])) pc = arg;
              else sp--;
              break;

            case Op.GET_ITER: {
              const v = stack[sp - 1];
              stack[sp - 1] = v instanceof PyList ? new SeqIterator(v.items) : this.iter(v);
              break;
            }
            case Op.FOR_ITER: {
              const it = stack[sp - 1];
              let v: PyValue | Done;
              if (it instanceof SeqIterator) {
                v = it.index < it.items.length ? it.items[it.index++] : DONE;
              } else if (it instanceof RangeIterator) {
                v = it.next();
              } else if (it instanceof PyGenerator && it.state !== 'done') {
                // Run the generator in this same loop; its next yield lands here.
                if (it.state === 'running') throw new ValueError('generator already executing');
                frame.pc = pc;
                frame.sp = sp;
                const genFrame = it.frame!;
                this.enterGenerator(it, genFrame, null);
                genFrame.inline = true;
                continue reload;
              } else {
                const r = this.next(it);
                if (r instanceof Promise) return this.wait(frame, pc, sp, Await.FOR_ITER, r);
                v = r;
              }
              if (v === DONE) {
                sp--;
                pc = arg;
              } else {
                if (++this.loopTicks > maxIterations) throw new MaxIterationsError();
                if ((this.loopTicks & 8191) === 0) this.checkDeadline();
                stack[sp++] = v;
              }
              break;
            }

            case Op.UNPACK_SEQUENCE:
            case Op.UNPACK_EX: {
              const seq = stack[--sp];
              let items: PyValue[];
              if (seq instanceof PyTuple || seq instanceof PyList) {
                items = seq.items;
              } else {
                let r: MA<PyValue[]>;
                try {
                  r = this.collect(seq);
                } catch (error) {
                  if (error instanceof TypeError && error.baseMessage.endsWith('is not iterable')) {
                    throw new TypeError(`cannot unpack non-iterable ${typeName(seq)} object`);
                  }
                  throw error;
                }
                if (r instanceof Promise) {
                  // Replay this instruction once the items are in hand.
                  return this.wait(frame, pc - 1, sp, Await.PUSH, r.then((list) => new PyList(list)));
                }
                items = r;
              }
              const n = items.length;
              if (ops[pc - 1] === Op.UNPACK_SEQUENCE) {
                if (n !== arg) {
                  throw new ValueError(n < arg
                    ? `not enough values to unpack (expected ${arg}, got ${n})`
                    : `too many values to unpack (expected ${arg}, got ${n})`);
                }
                for (let i = n - 1; i >= 0; i--) stack[sp++] = items[i];
              } else {
                const before = arg & 0xff;
                const after = arg >> 8;
                if (n < before + after) {
                  throw new ValueError(`not enough values to unpack (expected at least ${before + after}, got ${n})`);
                }
                for (let i = n - 1; i >= n - after; i--) stack[sp++] = items[i];
                stack[sp++] = new PyList(items.slice(before, n - after));
                for (let i = before - 1; i >= 0; i--) stack[sp++] = items[i];
              }
              break;
            }

            case Op.KW_NAMES:
              // Read by the call instruction that always follows.
              break;

            case Op.CALL:
            case Op.CALL_METHOD:
            case Op.CALL_EX: {
              let callee: PyValue;
              let argv: PyValue[];
              let kwargs: Kwargs = null;
              const op = ops[pc - 1];

              if (op === Op.CALL_EX) {
                if (arg === 1) {
                  kwargs = new Map();
                  for (const entry of (stack[--sp] as PyDict).map.values()) kwargs.set(entry[0] as string, entry[1]);
                }
                argv = (stack[--sp] as PyList).items;
                callee = stack[--sp];
              } else {
                const argc = op === Op.CALL ? arg : arg & 0xff;
                const target = op === Op.CALL ? stack[sp - argc - 1] : undefined;
                if (target instanceof PyFunction && target.code.simpleArgs && !target.code.isGenerator &&
                    argc <= target.code.argCount && argc >= target.code.argCount - target.defaults.length &&
                    !(pc >= 2 && ops[pc - 2] === Op.KW_NAMES)) {
                  sp -= argc + 1;
                  frame.pc = pc;
                  frame.sp = sp;
                  this.enterSimple(target, stack, sp + 1, argc);
                  continue reload;
                }
                let positional = argc;
                if (pc >= 2 && ops[pc - 2] === Op.KW_NAMES) {
                  const kwNames: string[] = consts[args[pc - 2]];
                  kwargs = new Map();
                  positional = argc - kwNames.length;
                  for (let i = 0; i < kwNames.length; i++) kwargs.set(kwNames[i], stack[sp - kwNames.length + i]);
                }
                sp -= argc;
                argv = positional === 0 ? NO_VALUES : stack.slice(sp, sp + positional);
                callee = stack[--sp];

                if (op === Op.CALL_METHOD) {
                  const name = names[arg >> 8];
                  const method = findMethod(callee, name);
                  if (method !== undefined) {
                    const r = method(this, callee, argv, kwargs);
                    if (r instanceof Promise) return this.wait(frame, pc, sp, Await.PUSH, r);
                    stack[sp++] = r;
                    break;
                  }
                  callee = getAttribute(callee, name);
                }
              }

              frame.pc = pc;
              frame.sp = sp;
              const r = this.invoke(callee, argv, kwargs);
              if (r === PUSHED) continue reload;
              if (r instanceof Promise) return this.wait(frame, pc, sp, Await.PUSH, r);
              stack[sp++] = r;
              break;
            }

            case Op.MAKE_FUNCTION: {
              const proto: FunctionProto = consts[arg];
              let kwDefaults: Map<string, PyValue> | null = null;
              const kwNames = proto.kwDefaultNames;
              if (kwNames.length > 0) {
                kwDefaults = new Map();
                sp -= kwNames.length;
                for (let i = 0; i < kwNames.length; i++) kwDefaults.set(kwNames[i], stack[sp + i]);
              }
              sp -= proto.defaultCount;
              const defaults = proto.defaultCount === 0 ? NO_VALUES : stack.slice(sp, sp + proto.defaultCount);
              const free = proto.freeCells;
              let closure: Cell[] | null = null;
              if (free.length > 0) {
                closure = new Array(free.length);
                for (let i = 0; i < free.length; i++) closure[i] = frame.cells[free[i]];
              }
              stack[sp++] = new PyFunction(proto.code.name, proto.code, defaults, kwDefaults, closure);
              break;
            }

            case Op.RETURN: {
              const value = stack[--sp];
              this.popFrame(frame);
              const gen = frame.gen;
              if (gen !== null) {
                gen.state = 'done';
                gen.returnValue = value;
                gen.frame = null;
                if (!frame.inline) return DONE;
                // The `for` loop driving this generator is finished.
                const loop = frames[frames.length - 1];
                loop.sp--;
                loop.pc = loop.code.args[loop.pc - 1];
                continue reload;
              }
              if (frames.length === base) return value;
              const caller = frames[frames.length - 1];
              caller.stack[caller.sp++] = value;
              continue reload;
            }
            case Op.YIELD: {
              const value = stack[--sp];
              frame.pc = pc;
              frame.sp = sp;
              frame.gen!.state = 'suspended';
              this.popFrame(frame);
              if (!frame.inline) return value;
              frame.inline = false;
              this.tickLoop();
              const loop = frames[frames.length - 1];
              loop.stack[loop.sp++] = value;
              continue reload;
            }
            case Op.YIELD_FROM_RESULT: {
              const it = stack[sp - 1];
              stack[sp - 1] = it instanceof PyGenerator ? it.returnValue : null;
              break;
            }

            case Op.RAISE: {
              const exc = stack[--sp];
              if (exc instanceof InterpreterError) throw exc;
              if (exc instanceof PyType && exc.jsClass) throw new exc.jsClass();
              throw new TypeError('exceptions must derive from BaseException');
            }
            case Op.RERAISE:
              throw stack[--sp];
            case Op.RERAISE_NONE:
              throw new RuntimeError('No active exception to reraise');
            case Op.RAISE_ASSERT: {
              const error = new AssertionError(arg === 1 ? pyStr(stack[sp - 1]) : '');
              if (arg === 1) error.args = [stack[--sp]];
              throw error;
            }
            case Op.EXC_MATCH: {
              const type = stack[--sp];
              const exc = stack[sp - 1];
              const types: PyValue[] = type instanceof PyTuple ? type.items : [type];
              let matched = false;
              for (const t of types) {
                if (!(t instanceof PyType) || !t.jsClass) {
                  throw new TypeError('catching classes that do not inherit from BaseException is not allowed');
                }
                if (exc instanceof t.jsClass) { matched = true; break; }
              }
              stack[sp - 1] = matched;
              break;
            }

            case Op.IMPORT_NAME: {
              const module = this.host.modules.get(names[arg]);
              if (!module) throw new ModuleNotFoundError(`No module named '${names[arg]}'`);
              stack[sp++] = module;
              break;
            }
            case Op.IMPORT_FROM: {
              const module = stack[sp - 1] as PyModule;
              const value = module.attrs.get(names[arg]);
              if (value === undefined) throw new ImportError(`cannot import name '${names[arg]}' from '${module.name}'`);
              stack[sp++] = value;
              break;
            }
            case Op.IMPORT_STAR: {
              const module = stack[--sp] as PyModule;
              for (const [name, value] of module.attrs) {
                if (!name.startsWith('_')) globals.set(name, value);
              }
              break;
            }

            case Op.STORE_RESULT:
              frame.result = stack[--sp];
              break;
            case Op.CLEAR_RESULT:
              frame.result = null;
              break;
            case Op.LOAD_RESULT:
              stack[sp++] = frame.result;
              break;
          }
        }
      } catch (error) {
        frame.pc = pc;
        frame.sp = sp;
        this.unwind(error, base);
      }
    }
  }
}
