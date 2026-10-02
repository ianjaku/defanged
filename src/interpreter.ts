/**
 * Public interpreter: owns the state that outlives a single run() (globals,
 * tools, modules, limits) and drives lex → parse → compile → VM.
 */

import { BuiltinCallbacks, PrintCallback, createBuiltins } from './builtins';
import { compile } from './compiler';
import { createDatetimeModule, makeTzConverter } from './datetime';
import { InterpreterError, TimeoutError, ToolError } from './errors';
import { mathModule } from './math';
import { parse } from './parser';
import { reModule } from './re';
import { statisticsModule } from './statistics';
import {
  DateConverter, Globals, PyBuiltin, PyDateTime, PyIterator, PyList, PyModule, PyValue, jsToValue, setOwn, valueToJs,
} from './values';
import { VM, VMHost, fromRangeError } from './vm';

/** Metadata for one tool parameter, used by generateToolsPrompt to render a
 *  Python-style signature. Purely descriptive — nothing is validated against it. */
export interface ToolParameter {
  name: string;
  /** Python type shown in the signature, e.g. 'str', 'int', 'list[dict]'. */
  type?: string;
  /** Rendered verbatim as the default value, e.g. '"USD"' or 'None'.
   *  A parameter with a default is implicitly optional. */
  default?: string;
  description?: string;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  /**
   * Called with the script's positional arguments (marshalled to plain JS
   * values) followed by ONE trailing kwargs object — always present when the
   * call site uses keyword arguments, `{}` included for zero-arg calls:
   *   f()          → handler({})
   *   f("a")       → handler("a", {})
   *   f("a", x=1)  → handler("a", { x: 1 })
   * Note the ambiguity: a final positional dict is indistinguishable from
   * kwargs. Prefer keyword-only tools or put dicts first.
   * A thrown JS error surfaces in Python as a catchable ToolError.
   */
  handler: (...args: any[]) => any | Promise<any>;
  /** Parameter metadata for generateToolsPrompt (signatures + per-arg docs). */
  parameters?: ToolParameter[];
  /** Section heading used by generateToolsPrompt to group large tool sets. */
  group?: string;
}

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
  tools?: ToolDefinition[];
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
    for (const tool of options.tools ?? []) {
      const name = tool.name.replace(/\(\)$/, '');
      if (!builtins.has(name)) builtins.set(name, this.toolFunction({ ...tool, name }));
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
      modules.set(module.name, module);
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

  async run(source: string): Promise<any> {
    const code = compile(parse(source.trim()), this.host.globals);
    const vm = new VM(this.host);
    let result = await this.withDeadline(vm.runModule(code));
    // A lazy iterator (zip, map, ...) reaches the host as its items.
    if (result instanceof PyIterator) result = new PyList((await vm.collect(result)).slice());
    try {
      return valueToJs(result, this.host.maxCollectionSize);
    } catch (e) {
      throw e instanceof RangeError ? fromRangeError(e) : e;
    }
  }

  /** Rejects when `timeoutMs` passes while the script is waiting on a tool
   *  that has not settled. The VM itself only checks the clock while running. */
  private withDeadline(running: PyValue | Promise<PyValue>): PyValue | Promise<PyValue> {
    const { timeoutMs } = this.host;
    if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || !(running instanceof Promise)) return running;
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs);
    });
    return Promise.race([running, expired]).finally(() => clearTimeout(timer));
  }

  private toolFunction(tool: ToolDefinition): PyBuiltin {
    return new PyBuiltin(tool.name, async (_rt, args, kwargs): Promise<PyValue> => {
      const options: Record<string, any> = {};
      if (kwargs) for (const [key, value] of kwargs) setOwn(options, key, valueToJs(value));
      let result: any;
      try {
        result = await tool.handler(...args.map((arg) => valueToJs(arg)), options);
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
