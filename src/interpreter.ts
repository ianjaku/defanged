/**
 * Public interpreter: owns the state that outlives a single run() (globals,
 * tools, modules, limits) and drives lex → parse → compile → VM.
 */

import { BuiltinCallbacks, PrintCallback, createBuiltins } from './builtins';
import { compile } from './compiler';
import { createDatetimeModule, makeTzConverter } from './datetime';
import { CancelledError, InterpreterError, TimeoutError, ToolError } from './errors';
import { mathModule } from './math';
import { parse } from './parser';
import { reModule } from './re';
import { statisticsModule } from './statistics';
import { NormalizedTool, ToolDefinition, Tools, normalizeTools, resolveArguments } from './tools';
import {
  DateConverter, Globals, PyBuiltin, PyDateTime, PyIterator, PyList, PyModule, PyValue, jsToValue, setOwn, valueToJs,
} from './values';
import { VM, VMHost, fromRangeError } from './vm';

/** Crude allocation bounds: an operation that would build one huge value
 *  (`[0] * 10**9`, `list(range(10**9))`, a giant join) fails with a Python
 *  MemoryError instead of taking the host down. Not precise accounting. */
export interface ResourceLimits {
  /** Maximum length of any single string, in characters. Default 10_000_000. */
  maxStringLength?: number;
  /** Maximum number of elements in any single list/tuple/range. Default 10_000_000. */
  maxCollectionSize?: number;
}

export interface InterpreterOptions extends BuiltinCallbacks {
  /** Functions the script may call, by name: a plain function, or
   *  `{ params, handler }` when the model needs types and descriptions.
   *  See `Tools` in tools.ts. The 0.3 array form is still accepted. */
  tools?: Tools | ToolDefinition[];
  onPrint?: PrintCallback;
  /** Budget for loop iterations, and separately for function calls, per
   *  run(). Exceeding either raises an uncatchable MaxIterationsError.
   *  Default 5,000,000. */
  maxIterations?: number;
  /** Wall-clock deadline for run(), including time spent inside awaited tool
   *  handlers (which maxIterations cannot bound). Raises an uncatchable
   *  TimeoutError. Default: no limit. */
  timeoutMs?: number;
  /** Allocation bounds; see ResourceLimits. Pass Infinity to disable one. */
  limits?: ResourceLimits;
  /** Clock used by datetime.now() / date.today(), in epoch milliseconds. Defaults to Date.now. */
  now?: () => number;
  /** IANA timezone (e.g. 'Europe/Berlin') the sandboxed code appears to run in. Defaults to 'UTC'. */
  timezone?: string;
  /** Extra importable modules, such as `json` from "defanged/json". Each
   *  must be pure computation: this is the only way to widen `import`. */
  modules?: PyModule[];
}

export interface RunOptions {
  /** Cancels the run: the script stops at its next checkpoint (every few
   *  thousand operations) or as soon as a pending tool call is abandoned. */
  signal?: AbortSignal;
}

export class Interpreter {
  private readonly host: VMHost;
  /** Converts JS Dates from tool results into naive datetimes in the
   *  session timezone — same wall clock as datetime.now(). */
  private readonly convertDate: DateConverter;

  constructor(options: InterpreterOptions = {}) {
    // Validates the timezone eagerly — an invalid IANA name throws here.
    const toSessionTz = makeTzConverter(options.timezone ?? 'UTC');
    this.convertDate = (date) => {
      const c = toSessionTz(date.getTime());
      return new PyDateTime(c.year, c.month, c.day, c.hour, c.minute, c.second, c.microsecond);
    };

    const builtins = createBuiltins({
      onPrint: options.onPrint,
      onChart: options.onChart,
      onTable: options.onTable,
    });
    // A tool never shadows a built-in of the same name.
    for (const tool of normalizeTools(options.tools)) {
      if (!builtins.has(tool.name)) builtins.set(tool.name, this.toolFunction(tool));
    }

    // math/statistics/re are stateless singletons; only datetime is built per
    // interpreter (it closes over the clock and timezone).
    const modules = new Map<string, PyModule>([
      ['datetime', createDatetimeModule(options.now ?? Date.now, options.timezone ?? 'UTC')],
      ['math', mathModule],
      ['statistics', statisticsModule],
      ['re', reModule],
    ]);
    for (const module of options.modules ?? []) {
      if (modules.has(module.name)) throw new Error(`Module '${module.name}' is already provided by defanged`);
      modules.set(module.name, module.fresh ? module.fresh() : module);
    }

    this.host = {
      globals: new Globals(),
      builtins,
      modules,
      maxIterations: options.maxIterations ?? 5_000_000,
      timeoutMs: options.timeoutMs,
      maxStringLength: options.limits?.maxStringLength ?? 10_000_000,
      maxCollectionSize: options.limits?.maxCollectionSize ?? 10_000_000,
    };
  }

  /** Runs a script. `signal` cancels it at the next checkpoint, or while it
   *  waits on a tool, with an uncatchable CancelledError. */
  async run(source: string, options: RunOptions = {}): Promise<any> {
    const signal = options.signal ?? null;
    if (signal !== null && signal.aborted) throw new CancelledError(signal.reason);
    const code = compile(parse(source.trim()), this.host.globals);
    const vm = new VM(this.host, signal);
    let result = await this.withDeadline(vm.runModule(code), signal);
    // A lazy iterator (zip, map, ...) reaches the host as its items.
    if (result instanceof PyIterator) result = new PyList((await vm.collect(result)).slice());
    try {
      return valueToJs(result, this.host.maxCollectionSize);
    } catch (e) {
      throw e instanceof RangeError ? fromRangeError(e) : e;
    }
  }

  /** Rejects when `timeoutMs` passes or `signal` fires while the script is
   *  waiting on a tool that has not settled. The VM itself only checks the
   *  clock and the signal while running. */
  private withDeadline(running: PyValue | Promise<PyValue>, signal: AbortSignal | null): PyValue | Promise<PyValue> {
    if (!(running instanceof Promise)) return running;
    const { timeoutMs } = this.host;
    const hasDeadline = timeoutMs !== undefined && Number.isFinite(timeoutMs);
    if (!hasDeadline && signal === null) return running;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      if (hasDeadline) timer = setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs);
      if (signal !== null) {
        onAbort = () => reject(new CancelledError(signal.reason));
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    return Promise.race([running, interrupted]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal!.removeEventListener('abort', onAbort);
    });
  }

  private toolFunction(tool: NormalizedTool): PyBuiltin {
    return new PyBuiltin(tool.name, async (_rt, args, kwargs): Promise<PyValue> => {
      let keywords: Record<string, any> | null = null;
      if (kwargs && kwargs.size > 0) {
        keywords = {};
        for (const [key, value] of kwargs) setOwn(keywords, key, valueToJs(value));
      }
      // Argument errors are the script's fault, so they stay Python TypeErrors.
      const jsArgs = await resolveArguments(tool, args.map((arg) => valueToJs(arg)), keywords);
      let result: any;
      try {
        result = await tool.fn(...jsArgs);
      } catch (e) {
        // A JS throw surfaces as a Python-catchable ToolError so scripts can
        // implement fallbacks; the VM stamps the call site onto it.
        if (e instanceof InterpreterError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        throw new ToolError(`Tool '${tool.name}' failed: ${msg}`);
      }
      return jsToValue(result, this.convertDate);
    }, true);
  }
}

export function createInterpreter(options?: InterpreterOptions): Interpreter {
  return new Interpreter(options);
}
