/**
 * Tree-walking interpreter for Python AST
 *
 * Performance: the core evaluate/execute methods return PyValue | Promise<PyValue>
 * instead of always Promise<PyValue>. This avoids microtask overhead for the common
 * case where no async operations (tools, generators) are involved.
 */

import {
  Program,
  Statement,
  Expression,
  Comprehension,
  Yield,
  YieldFrom,
} from './ast';
import {
  PyValue,
  PyBuiltin,
  PyKwargs,
  PyGenerator,
  Environment,
  pyNumber,
  pyString,
  pyBoolean,
  pyNone,
  pyList,
  pyDict,
  pySet,
  pyTuple,
  pyIterator,
  isNumber,
  isString,
  isBoolean,
  isNone,
  isList,
  isDict,
  isSet,
  isTuple,
  isCallable,
  isIterable,
  isTruthy,
  pyEquals,
  pyStr,
  pyRepr,
  jsToValue,
  valueToJs,
} from './values';
import { createBuiltins, PrintCallback, compareValues } from './builtins';
import { getStringMethod, getListMethod, getDictMethod, getSetMethod, getHashableItems } from './methods';
import {
  InterpreterError,
  NameError,
  TypeError,
  IndexError,
  KeyError,
  ValueError,
  ZeroDivisionError,
  StopIteration,
  MaxIterationsError,
} from './errors';
import { parse } from './parser';

// ── Sync/async plumbing ─────────────────────────────────────────────────────

type MA<T> = T | Promise<T>;

/** Monadic bind: if val is a Promise, .then(fn); otherwise call fn directly. */
function $<T, U>(val: MA<T>, fn: (v: T) => MA<U>): MA<U> {
  if (val instanceof Promise) return val.then(fn);
  return fn(val);
}

/** Void variant of $: chains after a void-returning MaybeAsync. */
function $v<U>(val: MA<void>, fn: () => MA<U>): MA<U> {
  if (val instanceof Promise) return val.then(fn);
  return fn();
}

// ── Control flow exceptions ─────────────────────────────────────────────────

class ReturnException {
  constructor(public value: PyValue) {}
}

class BreakException {}
class ContinueException {}

class YieldException {
  constructor(public value: PyValue) {}
}

function containsYield(stmts: Statement[]): boolean {
  for (const stmt of stmts) {
    if (stmtContainsYield(stmt)) return true;
  }
  return false;
}

function stmtContainsYield(stmt: Statement): boolean {
  switch (stmt.type) {
    case 'ExpressionStmt':
      return exprContainsYield(stmt.expression);
    case 'Assignment':
      return stmt.targets.some(exprContainsYield) || exprContainsYield(stmt.value);
    case 'AugmentedAssignment':
      return exprContainsYield(stmt.target) || exprContainsYield(stmt.value);
    case 'If':
      return exprContainsYield(stmt.test) || containsYield(stmt.body) || containsYield(stmt.orelse);
    case 'For':
      return containsYield(stmt.body) || containsYield(stmt.orelse);
    case 'While':
      return containsYield(stmt.body) || containsYield(stmt.orelse);
    case 'Return':
      return stmt.value ? exprContainsYield(stmt.value) : false;
    case 'Try':
      return containsYield(stmt.body) ||
        stmt.handlers.some(h => containsYield(h.body)) ||
        containsYield(stmt.orelse) ||
        containsYield(stmt.finalbody);
    case 'FunctionDef':
      return false;
    default:
      return false;
  }
}

function exprContainsYield(expr: Expression): boolean {
  switch (expr.type) {
    case 'Yield':
    case 'YieldFrom':
      return true;
    default:
      return false;
  }
}

// ── Public types ────────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description?: string;
  handler: (...args: any[]) => any | Promise<any>;
}

export interface InterpreterOptions {
  tools?: ToolDefinition[];
  onPrint?: PrintCallback;
  onChart?: (options: { type: string; data: unknown[]; x: string; y: string | string[]; title?: string }) => void;
  onTable?: (options: { data: unknown[]; columns: Array<{ key: string; label: string; format?: string }>; title?: string }) => void;
  maxIterations?: number;
}

// ── Interpreter ─────────────────────────────────────────────────────────────

export class Interpreter {
  private globals: Environment;
  private tools: Map<string, ToolDefinition>;
  private builtins: Map<string, PyBuiltin>;
  private maxIterations: number;
  private iterationCount: number = 0;
  private onPrint?: PrintCallback;

  constructor(options: InterpreterOptions = {}) {
    this.globals = new Environment();
    this.tools = new Map();
    this.maxIterations = options.maxIterations ?? 5_000_000;
    this.onPrint = options.onPrint;
    this.builtins = createBuiltins({
      onPrint: options.onPrint,
      onChart: options.onChart,
      onTable: options.onTable,
    });

    if (options.tools) {
      for (const tool of options.tools) {
        const name = tool.name.replace(/\(\)$/, '');
        this.tools.set(name, { ...tool, name });
      }
    }
  }

  async run(source: string): Promise<any> {
    this.iterationCount = 0;
    const program = parse(source.trim());
    const r = this.executeBlock(program, this.globals);
    const result = r instanceof Promise ? await r : r;
    return valueToJs(result);
  }

  // ── Block / statement execution ─────────────────────────────────────────

  private executeBlock(statements: Statement[], env: Environment): MA<PyValue> {
    let result: PyValue = pyNone();
    for (let i = 0; i < statements.length; i++) {
      const r = this.executeStatement(statements[i], env);
      if (r instanceof Promise) {
        return this.executeBlockAsync(statements, i, env, r);
      }
      result = r;
    }
    return result;
  }

  private async executeBlockAsync(
    statements: Statement[], from: number, env: Environment, pending: Promise<PyValue>
  ): Promise<PyValue> {
    let result = await pending;
    for (let i = from + 1; i < statements.length; i++) {
      const r = this.executeStatement(statements[i], env);
      result = r instanceof Promise ? await r : r;
    }
    return result;
  }

  private executeStatement(stmt: Statement, env: Environment): MA<PyValue> {
    switch (stmt.type) {
      case 'ExpressionStmt':
        return this.evaluate(stmt.expression, env);

      case 'Assignment':
        return $(this.evaluate(stmt.value, env), value => {
          return this.assignAllTargets(stmt.targets, value, env);
        });

      case 'AugmentedAssignment':
        return $(this.evaluate(stmt.target, env), current =>
          $(this.evaluate(stmt.value, env), operand => {
            let result: PyValue;
            switch (stmt.op) {
              case '+=': result = this.binaryOp('+', current, operand, stmt.line, stmt.column); break;
              case '-=': result = this.binaryOp('-', current, operand, stmt.line, stmt.column); break;
              case '*=': result = this.binaryOp('*', current, operand, stmt.line, stmt.column); break;
              case '/=': result = this.binaryOp('/', current, operand, stmt.line, stmt.column); break;
              case '//=': result = this.binaryOp('//', current, operand, stmt.line, stmt.column); break;
              case '%=': result = this.binaryOp('%', current, operand, stmt.line, stmt.column); break;
              case '**=': result = this.binaryOp('**', current, operand, stmt.line, stmt.column); break;
              default: throw new InterpreterError(`Unknown augmented assignment operator: ${stmt.op}`, stmt.line, stmt.column);
            }
            return $v(this.assignTarget(stmt.target, result, env), () => pyNone());
          })
        );

      case 'If':
        return $(this.evaluate(stmt.test, env), test => {
          if (isTruthy(test)) return this.executeBlock(stmt.body, env);
          if (stmt.orelse.length > 0) return this.executeBlock(stmt.orelse, env);
          return pyNone();
        });

      case 'For':
        return $(this.evaluate(stmt.iter, env), iter => {
          if (iter.type === 'generator') {
            return this.forLoopGeneratorAsync(stmt, iter, env);
          }
          const items = this.getIterableItems(iter, stmt.line, stmt.column);
          return this.forLoopItems(stmt, items, env);
        });

      case 'While':
        return this.whileLoop(stmt, env);

      case 'FunctionDef': {
        let func: PyValue = {
          type: 'function',
          name: stmt.name,
          params: stmt.params,
          restParam: stmt.restParam,
          kwargsParam: stmt.kwargsParam,
          body: stmt.body,
          closure: env,
        };
        if (stmt.decorators.length === 0) {
          env.set(stmt.name, func);
          return pyNone();
        }
        return this.applyDecorators(func, stmt.decorators, env, stmt.line, stmt.column, (decorated) => {
          env.set(stmt.name, decorated);
          return pyNone();
        });
      }

      case 'Return':
        if (!stmt.value) throw new ReturnException(pyNone());
        return $(this.evaluate(stmt.value, env), value => { throw new ReturnException(value); });

      case 'Break':
        throw new BreakException();

      case 'Continue':
        throw new ContinueException();

      case 'Pass':
        return pyNone();

      case 'Raise':
        if (!stmt.value) throw new InterpreterError('No active exception to re-raise', stmt.line, stmt.column);
        return $(this.evaluate(stmt.value, env), value => {
          const exName = (value as any).exceptionName;
          const msg = (value as any).exceptionMessage ?? pyStr(value);
          if (exName) {
            switch (exName) {
              case 'ValueError': throw new ValueError(msg, stmt.line, stmt.column);
              case 'TypeError': throw new TypeError(msg, stmt.line, stmt.column);
              case 'KeyError': throw new KeyError(msg, stmt.line, stmt.column);
              case 'IndexError': throw new IndexError(msg, stmt.line, stmt.column);
              case 'ZeroDivisionError': throw new ZeroDivisionError(stmt.line, stmt.column);
              case 'NameError': throw new NameError(msg, stmt.line, stmt.column);
              default: throw new InterpreterError(msg, stmt.line, stmt.column);
            }
          }
          throw new InterpreterError(msg, stmt.line, stmt.column);
        });

      case 'Global':
        for (const name of stmt.names) env.declareGlobal(name);
        return pyNone();

      case 'Nonlocal':
        for (const name of stmt.names) env.declareNonlocal(name);
        return pyNone();

      case 'Del':
        return this.deleteAllTargets(stmt.targets, env);

      case 'Assert':
        return $(this.evaluate(stmt.test, env), test => {
          if (!isTruthy(test)) {
            if (!stmt.msg) throw new InterpreterError('assertion error', stmt.line, stmt.column);
            return $(this.evaluate(stmt.msg, env), msgVal => {
              throw new InterpreterError(pyStr(msgVal), stmt.line, stmt.column);
            });
          }
          return pyNone();
        });

      case 'Try':
        return this.executeTry(stmt, env);

      default: {
        const unknownStmt = stmt as unknown as { type: string; line: number; column: number };
        throw new InterpreterError(`Unknown statement type: ${unknownStmt.type}`, unknownStmt.line, unknownStmt.column);
      }
    }
  }

  // ── Assignment ────────────────────────────────────────────────────────────

  private assignAllTargets(targets: Expression[], value: PyValue, env: Environment): MA<PyValue> {
    for (let i = 0; i < targets.length; i++) {
      const r = this.assignTarget(targets[i], value, env);
      if (r instanceof Promise) {
        return r.then(async () => {
          for (let j = i + 1; j < targets.length; j++) {
            const r2 = this.assignTarget(targets[j], value, env);
            if (r2 instanceof Promise) await r2;
          }
          return pyNone();
        });
      }
    }
    return pyNone();
  }

  private assignTarget(target: Expression, value: PyValue, env: Environment): MA<void> {
    switch (target.type) {
      case 'Identifier':
        env.set(target.name, value);
        return;

      case 'Tuple': {
        const elements = target.elements;
        let items: PyValue[];
        if (isList(value) || isTuple(value)) {
          items = value.elements;
        } else if (isString(value)) {
          items = value.value.split('').map(c => pyString(c));
        } else {
          throw new TypeError(`cannot unpack non-sequence ${value.type}`, target.line, target.column);
        }

        const starIdx = elements.findIndex(e => e.type === 'Starred');
        if (starIdx >= 0) {
          const before = elements.slice(0, starIdx);
          const after = elements.slice(starIdx + 1);
          const minRequired = before.length + after.length;
          if (items.length < minRequired) {
            throw new TypeError(
              `not enough values to unpack (expected at least ${minRequired}, got ${items.length})`,
              target.line, target.column
            );
          }
          return this.assignUnpackStarred(before, elements[starIdx], after, items, env);
        }

        if (items.length !== elements.length) {
          throw new TypeError(
            `not enough values to unpack (expected ${elements.length}, got ${items.length})`,
            target.line, target.column
          );
        }
        return this.assignMultiple(elements, items, env);
      }

      case 'Subscript':
        return $(this.evaluate(target.object, env), obj =>
          $(this.evaluate(target.index, env), index => {
            if (isList(obj)) {
              if (!isNumber(index)) throw new TypeError('list indices must be integers', target.line, target.column);
              let idx = index.value;
              if (idx < 0) idx = obj.elements.length + idx;
              if (idx < 0 || idx >= obj.elements.length) throw new IndexError('list assignment index out of range', target.line, target.column);
              obj.elements[idx] = value;
            } else if (isDict(obj)) {
              if (!isString(index) && !isNumber(index) && !isBoolean(index)) throw new TypeError('unhashable type for dict key', target.line, target.column);
              obj.entries.set(index.value, value);
            } else {
              throw new TypeError(`'${obj.type}' object does not support item assignment`, target.line, target.column);
            }
          })
        );

      case 'Attribute':
        return $(this.evaluate(target.object, env), obj => {
          if (isDict(obj)) {
            obj.entries.set(target.attr, value);
          } else {
            throw new TypeError(`'${obj.type}' object does not support attribute assignment`, target.line, target.column);
          }
        });

      case 'Slice':
        return $(this.evaluate(target.object, env), obj => {
          if (!isList(obj)) throw new TypeError(`'${obj.type}' object does not support slice assignment`, target.line, target.column);
          const evalLower = target.lower ? this.evaluate(target.lower, env) : null;
          const cont = (lower: PyValue | null) => {
            const evalUpper = target.upper ? this.evaluate(target.upper, env) : null;
            return $<PyValue | null, void>(evalUpper, upper => {
              const evalStep = target.step ? this.evaluate(target.step, env) : null;
              return $<PyValue | null, void>(evalStep, step => {
                let start = lower && isNumber(lower) ? lower.value : 0;
                let end = upper && isNumber(upper) ? upper.value : obj.elements.length;
                if (start < 0) start = Math.max(0, obj.elements.length + start);
                if (end < 0) end = Math.max(0, obj.elements.length + end);
                start = Math.min(start, obj.elements.length);
                end = Math.min(end, obj.elements.length);
                if (!isList(value) && !isTuple(value)) throw new TypeError('can only assign an iterable', target.line, target.column);
                if (step === null || (isNumber(step) && step.value === 1)) {
                  obj.elements.splice(start, end - start, ...value.elements);
                } else {
                  throw new TypeError('slice assignment with step is not supported', target.line, target.column);
                }
              });
            });
          };
          return $<PyValue | null, void>(evalLower, cont);
        });

      default:
        throw new InterpreterError(`Cannot assign to ${target.type}`, target.line, target.column);
    }
  }

  private assignMultiple(targets: Expression[], values: PyValue[], env: Environment): MA<void> {
    for (let i = 0; i < targets.length; i++) {
      const r = this.assignTarget(targets[i], values[i], env);
      if (r instanceof Promise) {
        return r.then(async () => {
          for (let j = i + 1; j < targets.length; j++) {
            const r2 = this.assignTarget(targets[j], values[j], env);
            if (r2 instanceof Promise) await r2;
          }
        });
      }
    }
  }

  private assignUnpackStarred(
    before: Expression[], starExpr: Expression, after: Expression[],
    items: PyValue[], env: Environment
  ): MA<void> {
    for (let i = 0; i < before.length; i++) {
      const r = this.assignTarget(before[i], items[i], env);
      if (r instanceof Promise) {
        return r.then(async () => {
          for (let j = i + 1; j < before.length; j++) {
            const r2 = this.assignTarget(before[j], items[j], env);
            if (r2 instanceof Promise) await r2;
          }
          const starItems = items.slice(before.length, items.length - after.length);
          const sr = this.assignTarget((starExpr as any).value, pyList(starItems), env);
          if (sr instanceof Promise) await sr;
          for (let j = 0; j < after.length; j++) {
            const ar = this.assignTarget(after[j], items[items.length - after.length + j], env);
            if (ar instanceof Promise) await ar;
          }
        });
      }
    }
    const starItems = items.slice(before.length, items.length - after.length);
    const sr = this.assignTarget((starExpr as any).value, pyList(starItems), env);
    if (sr instanceof Promise) {
      return sr.then(async () => {
        for (let j = 0; j < after.length; j++) {
          const ar = this.assignTarget(after[j], items[items.length - after.length + j], env);
          if (ar instanceof Promise) await ar;
        }
      });
    }
    for (let j = 0; j < after.length; j++) {
      const r = this.assignTarget(after[j], items[items.length - after.length + j], env);
      if (r instanceof Promise) {
        return r.then(async () => {
          for (let k = j + 1; k < after.length; k++) {
            const ar = this.assignTarget(after[k], items[items.length - after.length + k], env);
            if (ar instanceof Promise) await ar;
          }
        });
      }
    }
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  private deleteAllTargets(targets: Expression[], env: Environment): MA<PyValue> {
    for (let i = 0; i < targets.length; i++) {
      const r = this.deleteTarget(targets[i], env);
      if (r instanceof Promise) {
        return r.then(async () => {
          for (let j = i + 1; j < targets.length; j++) {
            const r2 = this.deleteTarget(targets[j], env);
            if (r2 instanceof Promise) await r2;
          }
          return pyNone();
        });
      }
    }
    return pyNone();
  }

  private deleteTarget(target: Expression, env: Environment): MA<void> {
    switch (target.type) {
      case 'Identifier':
        if (!env.has(target.name)) throw new NameError(target.name, target.line, target.column);
        env.delete(target.name);
        return;
      case 'Subscript':
        return $(this.evaluate(target.object, env), obj =>
          $(this.evaluate(target.index, env), index => {
            if (isList(obj)) {
              if (!isNumber(index)) throw new TypeError('list indices must be integers', target.line, target.column);
              let idx = index.value;
              if (idx < 0) idx = obj.elements.length + idx;
              if (idx < 0 || idx >= obj.elements.length) throw new IndexError('list assignment index out of range', target.line, target.column);
              obj.elements.splice(idx, 1);
            } else if (isDict(obj)) {
              if (!isString(index) && !isNumber(index) && !isBoolean(index)) throw new TypeError('unhashable type for dict key', target.line, target.column);
              if (!obj.entries.has(index.value)) throw new KeyError(String(index.value), target.line, target.column);
              obj.entries.delete(index.value);
            } else {
              throw new TypeError(`'${obj.type}' object does not support item deletion`, target.line, target.column);
            }
          })
        );
      default:
        throw new InterpreterError(`Cannot delete ${target.type}`, target.line, target.column);
    }
  }

  // ── Expression evaluation ─────────────────────────────────────────────────

  private evaluate(expr: Expression, env: Environment): MA<PyValue> {
    switch (expr.type) {
      case 'Number':
        return pyNumber(expr.value);

      case 'String':
        return pyString(expr.value);

      case 'Boolean':
        return pyBoolean(expr.value);

      case 'None':
        return pyNone();

      case 'Identifier': {
        const value = env.get(expr.name);
        if (value !== undefined) return value;
        const builtin = this.builtins.get(expr.name);
        if (builtin) return builtin;
        if (this.tools.has(expr.name)) {
          return {
            type: 'builtin',
            name: expr.name,
            acceptsKwargs: true,
            fn: async (...args: PyValue[]) => {
              const tool = this.tools.get(expr.name)!;
              const lastArg = args[args.length - 1];
              if (lastArg && isKwargsValue(lastArg)) {
                const kwargsArg = lastArg;
                const positionalArgs = args.slice(0, -1).map(valueToJs);
                const options: Record<string, any> = {};
                for (const key of Object.keys(kwargsArg.values)) {
                  options[key] = valueToJs(kwargsArg.values[key]);
                }
                if (positionalArgs.length === 0) {
                  return jsToValue(await tool.handler(options));
                } else {
                  return jsToValue(await tool.handler(...positionalArgs, options));
                }
              }
              return jsToValue(await tool.handler(...args.map(valueToJs)));
            },
          };
        }
        throw new NameError(expr.name, expr.line, expr.column);
      }

      case 'BinaryOp':
        return $(this.evaluate(expr.left, env), left =>
          $(this.evaluate(expr.right, env), right =>
            this.binaryOp(expr.op, left, right, expr.line, expr.column)
          )
        );

      case 'UnaryOp':
        return $(this.evaluate(expr.operand, env), operand =>
          this.unaryOp(expr.op, operand, expr.line, expr.column)
        );

      case 'BooleanOp':
        return $(this.evaluate(expr.left, env), left => {
          if (expr.op === 'and') {
            if (!isTruthy(left)) return left;
            return this.evaluate(expr.right, env);
          } else {
            if (isTruthy(left)) return left;
            return this.evaluate(expr.right, env);
          }
        });

      case 'Compare':
        return this.evaluateCompare(expr, env);

      case 'Call':
        return this.evaluateCall(expr, env);

      case 'Subscript':
        return $(this.evaluate(expr.object, env), obj =>
          $(this.evaluate(expr.index, env), index =>
            this.subscript(obj, index, expr.line, expr.column)
          )
        );

      case 'Slice':
        return $(this.evaluate(expr.object, env), obj => {
          const evalL = expr.lower ? this.evaluate(expr.lower, env) : null;
          return $<PyValue | null, PyValue>(evalL, lower => {
            const evalU = expr.upper ? this.evaluate(expr.upper, env) : null;
            return $<PyValue | null, PyValue>(evalU, upper => {
              const evalS = expr.step ? this.evaluate(expr.step, env) : null;
              return $<PyValue | null, PyValue>(evalS, step =>
                this.slice(obj, lower, upper, step, expr.line, expr.column)
              );
            });
          });
        });

      case 'Attribute':
        return $(this.evaluate(expr.object, env), obj =>
          this.getAttribute(obj, expr.attr, expr.line, expr.column)
        );

      case 'List':
        return this.evaluateArray(expr.elements, env, pyList);

      case 'Dict':
        return this.evaluateDict(expr, env);

      case 'Tuple':
        return this.evaluateArray(expr.elements, env, pyTuple);

      case 'ListComp':
        return this.evaluateListComp(expr.element, expr.generators, env);

      case 'DictComp':
        return this.evaluateDictComp(expr.key, expr.value, expr.generators, env);

      case 'SetComp':
        return this.evaluateSetComp(expr.element, expr.generators, env);

      case 'GeneratorExp':
        return this.evaluateGeneratorExp(expr.element, expr.generators, env);

      case 'Ternary':
        return $(this.evaluate(expr.test, env), test =>
          isTruthy(test) ? this.evaluate(expr.consequent, env) : this.evaluate(expr.alternate, env)
        );

      case 'Lambda':
        return {
          type: 'function' as const,
          name: '<lambda>',
          params: expr.params.map(p => ({ name: p })),
          body: [{ type: 'Return' as const, value: expr.body, line: expr.line, column: expr.column }],
          closure: env,
        };

      case 'FString':
        return this.evaluateFString(expr, env);

      case 'NamedExpr':
        return $(this.evaluate(expr.value, env), value => {
          env.set(expr.target, value);
          return value;
        });

      case 'Yield': {
        const yieldFn = this.findYieldFn(env);
        if (!yieldFn) throw new InterpreterError("'yield' outside function", expr.line, expr.column);
        if (!expr.value) return yieldFn(pyNone());
        return $(this.evaluate(expr.value, env), value => yieldFn(value));
      }

      case 'YieldFrom': {
        const yieldFn = this.findYieldFn(env);
        if (!yieldFn) throw new InterpreterError("'yield' outside function", expr.line, expr.column);
        return $(this.evaluate(expr.value, env), iterable => {
          if (iterable.type === 'generator') {
            return this.yieldFromGenerator(iterable, yieldFn);
          }
          const items = this.getIterableItems(iterable, expr.line, expr.column);
          return this.yieldFromItems(items, yieldFn);
        });
      }

      default: {
        const unknownExpr = expr as unknown as { type: string; line: number; column: number };
        throw new InterpreterError(`Unknown expression type: ${unknownExpr.type}`, unknownExpr.line, unknownExpr.column);
      }
    }
  }

  // ── Expression helpers ────────────────────────────────────────────────────

  private evaluateCompare(expr: Expression & { type: 'Compare' }, env: Environment): MA<PyValue> {
    return $(this.evaluate(expr.left, env), (left) => {
      return this.compareChain(expr.ops, expr.comparators, 0, left, env, expr.line, expr.column);
    });
  }

  private compareChain(
    ops: string[], comparators: Expression[], idx: number,
    left: PyValue, env: Environment, line: number, column: number
  ): MA<PyValue> {
    if (idx >= ops.length) return pyBoolean(true);
    return $(this.evaluate(comparators[idx], env), right => {
      if (!this.compare(ops[idx], left, right, line, column)) return pyBoolean(false);
      return this.compareChain(ops, comparators, idx + 1, right, env, line, column);
    });
  }

  private evaluateCall(expr: Expression & { type: 'Call' }, env: Environment): MA<PyValue> {
    return $(this.evaluate(expr.func, env), func => {
      return this.evaluateCallArgs(expr, func, env);
    });
  }

  private evaluateCallArgs(expr: Expression & { type: 'Call' }, func: PyValue, env: Environment): MA<PyValue> {
    const args: PyValue[] = [];
    // Evaluate positional args
    for (let i = 0; i < expr.args.length; i++) {
      const r = this.evaluate(expr.args[i], env);
      if (r instanceof Promise) {
        return r.then(async (val) => {
          args.push(val);
          for (let j = i + 1; j < expr.args.length; j++) {
            const r2 = this.evaluate(expr.args[j], env);
            args.push(r2 instanceof Promise ? await r2 : r2);
          }
          return this.evaluateCallArgsRest(expr, func, args, env);
        });
      }
      args.push(r);
    }
    return this.evaluateCallArgsRest(expr, func, args, env);
  }

  private evaluateCallArgsRest(
    expr: Expression & { type: 'Call' }, func: PyValue, args: PyValue[], env: Environment
  ): MA<PyValue> {
    // Expand *args
    if (expr.starArgs) {
      for (const starExpr of expr.starArgs) {
        const r = this.evaluate(starExpr, env);
        if (r instanceof Promise) {
          return r.then(async (starVal) => {
            args.push(...this.getIterableItems(starVal, expr.line, expr.column));
            // Process remaining starArgs
            const idx = expr.starArgs!.indexOf(starExpr);
            for (let j = idx + 1; j < expr.starArgs!.length; j++) {
              const r2 = this.evaluate(expr.starArgs![j], env);
              const sv = r2 instanceof Promise ? await r2 : r2;
              args.push(...this.getIterableItems(sv, expr.line, expr.column));
            }
            return this.evaluateCallKwargs(expr, func, args, env);
          });
        }
        args.push(...this.getIterableItems(r, expr.line, expr.column));
      }
    }
    return this.evaluateCallKwargs(expr, func, args, env);
  }

  private evaluateCallKwargs(
    expr: Expression & { type: 'Call' }, func: PyValue, args: PyValue[], env: Environment
  ): MA<PyValue> {
    const kwargs: Record<string, PyValue> = {};
    for (let i = 0; i < expr.kwargs.length; i++) {
      const kw = expr.kwargs[i];
      const r = this.evaluate(kw.value, env);
      if (r instanceof Promise) {
        return r.then(async (val) => {
          kwargs[kw.name] = val;
          for (let j = i + 1; j < expr.kwargs.length; j++) {
            const r2 = this.evaluate(expr.kwargs[j].value, env);
            kwargs[expr.kwargs[j].name] = r2 instanceof Promise ? await r2 : r2;
          }
          return this.evaluateCallDoubleStarAndInvoke(expr, func, args, kwargs, env);
        });
      }
      kwargs[kw.name] = r;
    }
    return this.evaluateCallDoubleStarAndInvoke(expr, func, args, kwargs, env);
  }

  private evaluateCallDoubleStarAndInvoke(
    expr: Expression & { type: 'Call' }, func: PyValue, args: PyValue[],
    kwargs: Record<string, PyValue>, env: Environment
  ): MA<PyValue> {
    if (expr.doubleStarArgs) {
      for (const dsExpr of expr.doubleStarArgs) {
        const r = this.evaluate(dsExpr, env);
        if (r instanceof Promise) {
          return r.then(async (dsVal) => {
            if (!isDict(dsVal)) throw new TypeError('argument after ** must be a mapping', expr.line, expr.column);
            for (const [k, v] of dsVal.entries) kwargs[String(k)] = v;
            const idx = expr.doubleStarArgs!.indexOf(dsExpr);
            for (let j = idx + 1; j < expr.doubleStarArgs!.length; j++) {
              const r2 = this.evaluate(expr.doubleStarArgs![j], env);
              const dv = r2 instanceof Promise ? await r2 : r2;
              if (!isDict(dv)) throw new TypeError('argument after ** must be a mapping', expr.line, expr.column);
              for (const [k, v] of dv.entries) kwargs[String(k)] = v;
            }
            return this.call(func, args, kwargs, expr.line, expr.column);
          });
        }
        if (!isDict(r)) throw new TypeError('argument after ** must be a mapping', expr.line, expr.column);
        for (const [k, v] of r.entries) kwargs[String(k)] = v;
      }
    }
    return this.call(func, args, kwargs, expr.line, expr.column);
  }

  private evaluateArray(elements: Expression[], env: Environment, wrap: (els: PyValue[]) => PyValue): MA<PyValue> {
    const result: PyValue[] = [];
    for (let i = 0; i < elements.length; i++) {
      const r = this.evaluate(elements[i], env);
      if (r instanceof Promise) {
        return r.then(async (val) => {
          result.push(val);
          for (let j = i + 1; j < elements.length; j++) {
            const r2 = this.evaluate(elements[j], env);
            result.push(r2 instanceof Promise ? await r2 : r2);
          }
          return wrap(result);
        });
      }
      result.push(r);
    }
    return wrap(result);
  }

  private evaluateDict(expr: Expression & { type: 'Dict' }, env: Environment): MA<PyValue> {
    const entries = new Map<string | number | boolean, PyValue>();
    for (let i = 0; i < expr.keys.length; i++) {
      const kr = this.evaluate(expr.keys[i], env);
      if (kr instanceof Promise) {
        return kr.then(async (key) => {
          if (!isString(key) && !isNumber(key) && !isBoolean(key)) throw new TypeError('unhashable type for dict key', expr.line, expr.column);
          const vr = this.evaluate(expr.values[i], env);
          const val = vr instanceof Promise ? await vr : vr;
          entries.set(key.value, val);
          for (let j = i + 1; j < expr.keys.length; j++) {
            const kr2 = this.evaluate(expr.keys[j], env);
            const key2 = kr2 instanceof Promise ? await kr2 : kr2;
            if (!isString(key2) && !isNumber(key2) && !isBoolean(key2)) throw new TypeError('unhashable type for dict key', expr.line, expr.column);
            const vr2 = this.evaluate(expr.values[j], env);
            const val2 = vr2 instanceof Promise ? await vr2 : vr2;
            entries.set(key2.value, val2);
          }
          return pyDict(entries);
        });
      }
      const key = kr;
      if (!isString(key) && !isNumber(key) && !isBoolean(key)) throw new TypeError('unhashable type for dict key', expr.line, expr.column);
      const vr = this.evaluate(expr.values[i], env);
      if (vr instanceof Promise) {
        return vr.then(async (val) => {
          entries.set(key.value, val);
          for (let j = i + 1; j < expr.keys.length; j++) {
            const kr2 = this.evaluate(expr.keys[j], env);
            const key2 = kr2 instanceof Promise ? await kr2 : kr2;
            if (!isString(key2) && !isNumber(key2) && !isBoolean(key2)) throw new TypeError('unhashable type for dict key', expr.line, expr.column);
            const vr2 = this.evaluate(expr.values[j], env);
            entries.set(key2.value, vr2 instanceof Promise ? await vr2 : vr2);
          }
          return pyDict(entries);
        });
      }
      entries.set(key.value, vr);
    }
    return pyDict(entries);
  }

  private evaluateFString(expr: Expression & { type: 'FString' }, env: Environment): MA<PyValue> {
    let result = '';
    for (let i = 0; i < expr.parts.length; i++) {
      const part = expr.parts[i];
      result += part.text;
      if (part.expr) {
        const r = this.evaluate(part.expr, env);
        if (r instanceof Promise) {
          return r.then(async (value) => {
            result += part.formatSpec ? applyFormatSpec(value, part.formatSpec) : pyStr(value);
            for (let j = i + 1; j < expr.parts.length; j++) {
              const p = expr.parts[j];
              result += p.text;
              if (p.expr) {
                const r2 = this.evaluate(p.expr, env);
                const v2 = r2 instanceof Promise ? await r2 : r2;
                result += p.formatSpec ? applyFormatSpec(v2, p.formatSpec) : pyStr(v2);
              }
            }
            return pyString(result);
          });
        }
        result += part.formatSpec ? applyFormatSpec(r, part.formatSpec) : pyStr(r);
      }
    }
    return pyString(result);
  }

  // ── Yield helpers ─────────────────────────────────────────────────────────

  private async yieldFromGenerator(gen: PyGenerator, yieldFn: (v: PyValue) => Promise<PyValue>): Promise<PyValue> {
    let result = await gen.next();
    while (!result.done) {
      await yieldFn(result.value);
      result = await gen.next();
    }
    return result.value;
  }

  private async yieldFromItems(items: PyValue[], yieldFn: (v: PyValue) => Promise<PyValue>): Promise<PyValue> {
    for (const item of items) {
      await yieldFn(item);
    }
    return pyNone();
  }

  // ── Comprehensions ────────────────────────────────────────────────────────

  private evaluateListComp(element: Expression, generators: Comprehension[], env: Environment): MA<PyValue> {
    const results: PyValue[] = [];
    const r = this.evaluateComprehension(generators, 0, env, (innerEnv) => {
      const val = this.evaluate(element, innerEnv);
      return $(val, v => { results.push(v); });
    });
    return $(r, () => pyList(results));
  }

  private evaluateDictComp(keyExpr: Expression, valueExpr: Expression, generators: Comprehension[], env: Environment): MA<PyValue> {
    const entries = new Map<string | number | boolean, PyValue>();
    const r = this.evaluateComprehension(generators, 0, env, (innerEnv) => {
      return $(this.evaluate(keyExpr, innerEnv), key =>
        $(this.evaluate(valueExpr, innerEnv), value => {
          if (!isString(key) && !isNumber(key) && !isBoolean(key)) throw new TypeError('unhashable type for dict key', keyExpr.line, keyExpr.column);
          entries.set(key.value, value);
        })
      );
    });
    return $(r, () => pyDict(entries));
  }

  private evaluateSetComp(element: Expression, generators: Comprehension[], env: Environment): MA<PyValue> {
    const values = new Set<string | number | boolean>();
    const r = this.evaluateComprehension(generators, 0, env, (innerEnv) => {
      return $(this.evaluate(element, innerEnv), val => {
        if (!isString(val) && !isNumber(val) && !isBoolean(val)) throw new TypeError(`unhashable type: '${val.type}'`, element.line, element.column);
        values.add(val.value);
      });
    });
    return $(r, () => pySet(values));
  }

  private evaluateGeneratorExp(element: Expression, generators: Comprehension[], env: Environment): MA<PyValue> {
    const results: PyValue[] = [];
    const r = this.evaluateComprehension(generators, 0, env, (innerEnv) => {
      return $(this.evaluate(element, innerEnv), v => { results.push(v); });
    });
    return $(r, () => pyIterator(results));
  }

  private evaluateComprehension(
    generators: Comprehension[], index: number, env: Environment,
    callback: (env: Environment) => MA<void>
  ): MA<void> {
    if (index >= generators.length) return callback(env);

    const gen = generators[index];
    return $(this.evaluate(gen.iter, env), iter => {
      const items = this.getIterableItems(iter, 0, 0);
      return this.comprehensionLoop(items, 0, gen, generators, index, env, callback);
    });
  }

  private comprehensionLoop(
    items: PyValue[], i: number,
    gen: Comprehension, generators: Comprehension[], index: number,
    env: Environment, callback: (env: Environment) => MA<void>
  ): MA<void> {
    for (; i < items.length; i++) {
      this.checkIterations(0, 0);
      const innerEnv = new Environment(env);
      const ar = this.assignTarget(gen.target, items[i], innerEnv);
      if (ar instanceof Promise) {
        const ii = i;
        return ar.then(async () => {
          // Check conditions for this iteration
          let pass = true;
          for (const cond of gen.conditions) {
            const cr = this.evaluate(cond, innerEnv);
            const cv = cr instanceof Promise ? await cr : cr;
            if (!isTruthy(cv)) { pass = false; break; }
          }
          if (pass) {
            const r = this.evaluateComprehension(generators, index + 1, innerEnv, callback);
            if (r instanceof Promise) await r;
          }
          // Continue remaining iterations async
          for (let j = ii + 1; j < items.length; j++) {
            this.checkIterations(0, 0);
            const ie = new Environment(env);
            const ar2 = this.assignTarget(gen.target, items[j], ie);
            if (ar2 instanceof Promise) await ar2;
            let p2 = true;
            for (const cond of gen.conditions) {
              const cr = this.evaluate(cond, ie);
              if (!isTruthy(cr instanceof Promise ? await cr : cr)) { p2 = false; break; }
            }
            if (p2) {
              const r = this.evaluateComprehension(generators, index + 1, ie, callback);
              if (r instanceof Promise) await r;
            }
          }
        });
      }
      // Check conditions synchronously
      let pass = true;
      for (const cond of gen.conditions) {
        const cr = this.evaluate(cond, innerEnv);
        if (cr instanceof Promise) {
          const ii = i;
          return cr.then(async (cv) => {
            if (!isTruthy(cv)) { pass = false; }
            if (pass) {
              const r = this.evaluateComprehension(generators, index + 1, innerEnv, callback);
              if (r instanceof Promise) await r;
            }
            // Continue remaining
            for (let j = ii + 1; j < items.length; j++) {
              this.checkIterations(0, 0);
              const ie = new Environment(env);
              const ar2 = this.assignTarget(gen.target, items[j], ie);
              if (ar2 instanceof Promise) await ar2;
              let p2 = true;
              for (const c of gen.conditions) {
                const cr2 = this.evaluate(c, ie);
                if (!isTruthy(cr2 instanceof Promise ? await cr2 : cr2)) { p2 = false; break; }
              }
              if (p2) {
                const r = this.evaluateComprehension(generators, index + 1, ie, callback);
                if (r instanceof Promise) await r;
              }
            }
          });
        }
        if (!isTruthy(cr)) { pass = false; break; }
      }
      if (pass) {
        const r = this.evaluateComprehension(generators, index + 1, innerEnv, callback);
        if (r instanceof Promise) {
          const ii = i;
          return r.then(async () => {
            for (let j = ii + 1; j < items.length; j++) {
              this.checkIterations(0, 0);
              const ie = new Environment(env);
              const ar2 = this.assignTarget(gen.target, items[j], ie);
              if (ar2 instanceof Promise) await ar2;
              let p2 = true;
              for (const c of gen.conditions) {
                const cr2 = this.evaluate(c, ie);
                if (!isTruthy(cr2 instanceof Promise ? await cr2 : cr2)) { p2 = false; break; }
              }
              if (p2) {
                const rr = this.evaluateComprehension(generators, index + 1, ie, callback);
                if (rr instanceof Promise) await rr;
              }
            }
          });
        }
      }
    }
  }

  // ── Operators ─────────────────────────────────────────────────────────────

  private binaryOp(op: string, left: PyValue, right: PyValue, line: number, column: number): PyValue {
    if (isBoolean(left) && (isNumber(right) || isBoolean(right))) {
      left = pyNumber(left.value ? 1 : 0);
    }
    if (isBoolean(right) && (isNumber(left) || isBoolean(right))) {
      right = pyNumber(right.value ? 1 : 0);
    }
    if (op === '+' && isString(left) && isString(right)) return pyString(left.value + right.value);
    if (op === '%' && isString(left)) {
      const values: PyValue[] = isTuple(right) ? right.elements : [right];
      let i = 0;
      const result = left.value.replace(/%([+-]?\d*\.?\d*[sdifr%oxXe])/g, (match, spec) => {
        if (spec === '%') return '%';
        const val = values[i++];
        const typeChar = spec[spec.length - 1];
        switch (typeChar) {
          case 's': return pyStr(val);
          case 'r': return pyRepr(val);
          case 'd': case 'i': return String(Math.trunc(isNumber(val) ? val.value : 0));
          case 'f': return (isNumber(val) ? val.value : 0).toFixed(spec.match(/\.(\d+)/)?.[1] ? parseInt(spec.match(/\.(\d+)/)![1]) : 6);
          case 'o': return Math.trunc(isNumber(val) ? val.value : 0).toString(8);
          case 'x': return Math.trunc(isNumber(val) ? val.value : 0).toString(16);
          case 'X': return Math.trunc(isNumber(val) ? val.value : 0).toString(16).toUpperCase();
          case 'e': return (isNumber(val) ? val.value : 0).toExponential(spec.match(/\.(\d+)/)?.[1] ? parseInt(spec.match(/\.(\d+)/)![1]) : 6);
          default: return match;
        }
      });
      return pyString(result);
    }
    if (op === '*' && isString(left) && isNumber(right)) return pyString(left.value.repeat(Math.max(0, Math.floor(right.value))));
    if (op === '*' && isNumber(left) && isString(right)) return pyString(right.value.repeat(Math.max(0, Math.floor(left.value))));
    if (op === '+' && isList(left) && isList(right)) return pyList([...left.elements, ...right.elements]);
    if (op === '+' && isTuple(left) && isTuple(right)) return pyTuple([...left.elements, ...right.elements]);
    if (op === '*' && isList(left) && isNumber(right)) {
      const result: PyValue[] = [];
      for (let i = 0; i < Math.max(0, Math.floor(right.value)); i++) result.push(...left.elements);
      return pyList(result);
    }
    if (isNumber(left) && isNumber(right)) {
      switch (op) {
        case '+': return pyNumber(left.value + right.value);
        case '-': return pyNumber(left.value - right.value);
        case '*': return pyNumber(left.value * right.value);
        case '/':
          if (right.value === 0) throw new ZeroDivisionError(line, column);
          return pyNumber(left.value / right.value);
        case '//':
          if (right.value === 0) throw new ZeroDivisionError(line, column);
          return pyNumber(Math.floor(left.value / right.value));
        case '%':
          if (right.value === 0) throw new ZeroDivisionError(line, column);
          return pyNumber(((left.value % right.value) + right.value) % right.value);
        case '**': return pyNumber(Math.pow(left.value, right.value));
        case '&': return pyNumber(Math.trunc(left.value) & Math.trunc(right.value));
        case '|': return pyNumber(Math.trunc(left.value) | Math.trunc(right.value));
        case '^': return pyNumber(Math.trunc(left.value) ^ Math.trunc(right.value));
        case '<<': return pyNumber(Math.trunc(left.value) << Math.trunc(right.value));
        case '>>': return pyNumber(Math.trunc(left.value) >> Math.trunc(right.value));
      }
    }
    if ((op === '+' || op === '-' || op === '*') &&
        (isNumber(left) || isNone(left)) && (isNumber(right) || isNone(right))) {
      const leftVal = isNone(left) ? 0 : left.value;
      const rightVal = isNone(right) ? 0 : right.value;
      switch (op) {
        case '+': return pyNumber(leftVal + rightVal);
        case '-': return pyNumber(leftVal - rightVal);
        case '*': return pyNumber(leftVal * rightVal);
      }
    }
    throw new TypeError(`unsupported operand type(s) for ${op}: '${left.type}' and '${right.type}'`, line, column);
  }

  private unaryOp(op: string, operand: PyValue, line: number, column: number): PyValue {
    switch (op) {
      case '-':
        if (isNumber(operand)) return pyNumber(-operand.value);
        throw new TypeError(`bad operand type for unary -: '${operand.type}'`, line, column);
      case '+':
        if (isNumber(operand)) return operand;
        throw new TypeError(`bad operand type for unary +: '${operand.type}'`, line, column);
      case '~':
        if (isNumber(operand)) return pyNumber(~Math.trunc(operand.value));
        throw new TypeError(`bad operand type for unary ~: '${operand.type}'`, line, column);
      case 'not':
        return pyBoolean(!isTruthy(operand));
      default:
        throw new InterpreterError(`Unknown unary operator: ${op}`, line, column);
    }
  }

  private compare(op: string, left: PyValue, right: PyValue, line: number, column: number): boolean {
    switch (op) {
      case '==': return pyEquals(left, right);
      case '!=': return !pyEquals(left, right);
      case '<': case '>': case '<=': case '>=':
        if (isNumber(left) && isNumber(right)) {
          switch (op) {
            case '<': return left.value < right.value;
            case '>': return left.value > right.value;
            case '<=': return left.value <= right.value;
            case '>=': return left.value >= right.value;
          }
        }
        if (isString(left) && isString(right)) {
          switch (op) {
            case '<': return left.value < right.value;
            case '>': return left.value > right.value;
            case '<=': return left.value <= right.value;
            case '>=': return left.value >= right.value;
          }
        }
        throw new TypeError(`'${op}' not supported between '${left.type}' and '${right.type}'`, line, column);
      case 'in': return this.contains(right, left, line, column);
      case 'not in': return !this.contains(right, left, line, column);
      case 'is':
        if (isNone(left) && isNone(right)) return true;
        if (isNone(left) || isNone(right)) return false;
        return pyEquals(left, right);
      case 'is not':
        if (isNone(left) && isNone(right)) return false;
        if (isNone(left) || isNone(right)) return true;
        return !pyEquals(left, right);
      default:
        throw new InterpreterError(`Unknown comparison operator: ${op}`, line, column);
    }
  }

  private contains(container: PyValue, item: PyValue, line: number, column: number): boolean {
    if (isList(container) || isTuple(container)) return container.elements.some(el => pyEquals(el, item));
    if (isString(container)) {
      if (!isString(item)) throw new TypeError(`'in <string>' requires string as left operand`, line, column);
      return container.value.includes(item.value);
    }
    if (isDict(container)) {
      if (!isString(item) && !isNumber(item) && !isBoolean(item)) throw new TypeError('unhashable type', line, column);
      return container.entries.has(item.value);
    }
    if (isSet(container)) {
      if (!isString(item) && !isNumber(item) && !isBoolean(item)) throw new TypeError('unhashable type', line, column);
      return container.values.has(item.value);
    }
    throw new TypeError(`argument of type '${container.type}' is not iterable`, line, column);
  }

  // ── Function call ─────────────────────────────────────────────────────────

  private call(func: PyValue, args: PyValue[], kwargs: Record<string, PyValue>, line: number, column: number): MA<PyValue> {
    if (func.type === 'builtin') {
      if ((func as any).requiresInterpreter) {
        return this.handleSpecialBuiltin(func.name, args, kwargs, line, column);
      }
      if (func.acceptsKwargs) {
        const r = func.fn(...args, { type: 'kwargs' as const, values: kwargs });
        return r instanceof Promise ? r : r;
      }
      const r = func.fn(...args);
      return r instanceof Promise ? r : r;
    }

    if (func.type === 'function') {
      const funcEnv = new Environment(func.closure);
      const usedKwargs = new Set<string>();

      // Bind parameters — mostly sync, but default values may need evaluation
      for (let i = 0; i < func.params.length; i++) {
        const param = func.params[i];
        let value: PyValue | undefined;

        if (kwargs[param.name] !== undefined) {
          value = kwargs[param.name];
          usedKwargs.add(param.name);
        } else if (i < args.length) {
          value = args[i];
        } else if (param.default !== undefined) {
          const defR = this.evaluate(param.default, func.closure);
          if (defR instanceof Promise) {
            return defR.then(async (defVal) => {
              funcEnv.set(param.name, defVal);
              // Bind remaining params async
              for (let j = i + 1; j < func.params.length; j++) {
                const p = func.params[j];
                let v: PyValue;
                if (kwargs[p.name] !== undefined) { v = kwargs[p.name]; usedKwargs.add(p.name); }
                else if (j < args.length) { v = args[j]; }
                else if (p.default !== undefined) {
                  const dr = this.evaluate(p.default, func.closure);
                  v = dr instanceof Promise ? await dr : dr;
                }
                else throw new TypeError(`${func.name}() missing required argument: '${p.name}'`, line, column);
                funcEnv.set(p.name, v);
              }
              return this.callBound(func, funcEnv, args, kwargs, usedKwargs, line, column);
            });
          }
          value = defR;
        } else {
          throw new TypeError(`${func.name}() missing required argument: '${param.name}'`, line, column);
        }
        funcEnv.set(param.name, value);
      }

      return this.callBound(func, funcEnv, args, kwargs, usedKwargs, line, column);
    }

    throw new TypeError(`'${func.type}' object is not callable`, line, column);
  }

  private callBound(
    func: PyValue & { type: 'function' }, funcEnv: Environment,
    args: PyValue[], kwargs: Record<string, PyValue>, usedKwargs: Set<string>,
    line: number, column: number
  ): MA<PyValue> {
    if (func.restParam) {
      funcEnv.set(func.restParam, pyTuple(args.slice(func.params.length)));
    }
    if (func.kwargsParam) {
      const entries = new Map<string | number | boolean, PyValue>();
      for (const [k, v] of Object.entries(kwargs)) {
        if (!usedKwargs.has(k)) entries.set(k, v);
      }
      funcEnv.set(func.kwargsParam, pyDict(entries));
    }

    if (containsYield(func.body)) {
      return this.createGenerator(func.name, func.body, funcEnv);
    }

    try {
      const r = this.executeBlock(func.body, funcEnv);
      if (r instanceof Promise) {
        return r.then(
          () => pyNone(),
          (e: any) => { if (e instanceof ReturnException) return e.value; throw e; }
        );
      }
      return pyNone();
    } catch (e) {
      if (e instanceof ReturnException) return e.value;
      throw e;
    }
  }

  // ── Decorators ────────────────────────────────────────────────────────────

  private applyDecorators(
    func: PyValue, decorators: Expression[], env: Environment,
    line: number, column: number, done: (f: PyValue) => MA<PyValue>
  ): MA<PyValue> {
    let current = func;
    // Apply bottom-up
    for (let i = decorators.length - 1; i >= 0; i--) {
      const r = this.evaluate(decorators[i], env);
      if (r instanceof Promise) {
        return r.then(async (deco) => {
          const cr = this.call(deco, [current], {}, line, column);
          current = cr instanceof Promise ? await cr : cr;
          for (let j = i - 1; j >= 0; j--) {
            const dr = this.evaluate(decorators[j], env);
            const d = dr instanceof Promise ? await dr : dr;
            const ar = this.call(d, [current], {}, line, column);
            current = ar instanceof Promise ? await ar : ar;
          }
          return done(current);
        });
      }
      const callR = this.call(r, [current], {}, line, column);
      if (callR instanceof Promise) {
        return callR.then(async (result) => {
          current = result;
          for (let j = i - 1; j >= 0; j--) {
            const dr = this.evaluate(decorators[j], env);
            const d = dr instanceof Promise ? await dr : dr;
            const ar = this.call(d, [current], {}, line, column);
            current = ar instanceof Promise ? await ar : ar;
          }
          return done(current);
        });
      }
      current = callR;
    }
    return done(current);
  }

  // ── Loops ─────────────────────────────────────────────────────────────────

  private forLoopItems(stmt: Statement & { type: 'For' }, items: PyValue[], env: Environment): MA<PyValue> {
    let result: PyValue = pyNone();
    let didBreak = false;

    for (let i = 0; i < items.length; i++) {
      this.checkIterations(stmt.line, stmt.column);
      const ar = this.assignTarget(stmt.target, items[i], env);
      if (ar instanceof Promise) {
        return ar.then(() => this.forLoopItemsAsync(stmt, items, i, env, true));
      }
      try {
        const br = this.executeBlock(stmt.body, env);
        if (br instanceof Promise) {
          return br.then(
            (val) => this.forLoopItemsAsync(stmt, items, i + 1, env, false),
            (e: any) => {
              if (e instanceof BreakException) return this.forElse(stmt, true, env);
              if (e instanceof ContinueException) return this.forLoopItemsAsync(stmt, items, i + 1, env, false);
              throw e;
            }
          );
        }
        result = br;
      } catch (e) {
        if (e instanceof BreakException) { didBreak = true; break; }
        if (e instanceof ContinueException) continue;
        throw e;
      }
    }
    if (!didBreak && stmt.orelse.length > 0) return this.executeBlock(stmt.orelse, env);
    return result;
  }

  private async forLoopItemsAsync(
    stmt: Statement & { type: 'For' }, items: PyValue[], startIdx: number,
    env: Environment, runBody: boolean
  ): Promise<PyValue> {
    let result: PyValue = pyNone();
    let didBreak = false;
    let start = startIdx;

    if (runBody) {
      try {
        const br = this.executeBlock(stmt.body, env);
        result = br instanceof Promise ? await br : br;
      } catch (e) {
        if (e instanceof BreakException) { didBreak = true; }
        else if (e instanceof ContinueException) { /* continue to next */ }
        else throw e;
      }
      start = startIdx + 1;
    }

    if (!didBreak) {
      for (let i = start; i < items.length; i++) {
        this.checkIterations(stmt.line, stmt.column);
        const ar = this.assignTarget(stmt.target, items[i], env);
        if (ar instanceof Promise) await ar;
        try {
          const br = this.executeBlock(stmt.body, env);
          result = br instanceof Promise ? await br : br;
        } catch (e) {
          if (e instanceof BreakException) { didBreak = true; break; }
          if (e instanceof ContinueException) continue;
          throw e;
        }
      }
    }

    if (!didBreak && stmt.orelse.length > 0) {
      const r = this.executeBlock(stmt.orelse, env);
      return r instanceof Promise ? await r : r;
    }
    return result;
  }

  private async forLoopGeneratorAsync(stmt: Statement & { type: 'For' }, iter: PyGenerator, env: Environment): Promise<PyValue> {
    let result: PyValue = pyNone();
    let didBreak = false;
    let genResult = await iter.next();
    while (!genResult.done) {
      this.checkIterations(stmt.line, stmt.column);
      const ar = this.assignTarget(stmt.target, genResult.value, env);
      if (ar instanceof Promise) await ar;
      try {
        const br = this.executeBlock(stmt.body, env);
        result = br instanceof Promise ? await br : br;
      } catch (e) {
        if (e instanceof BreakException) { didBreak = true; break; }
        if (e instanceof ContinueException) { genResult = await iter.next(); continue; }
        throw e;
      }
      genResult = await iter.next();
    }
    if (!didBreak && stmt.orelse.length > 0) {
      const r = this.executeBlock(stmt.orelse, env);
      return r instanceof Promise ? await r : r;
    }
    return result;
  }

  private forElse(stmt: Statement & { type: 'For' }, didBreak: boolean, env: Environment): MA<PyValue> {
    if (!didBreak && stmt.orelse.length > 0) return this.executeBlock(stmt.orelse, env);
    return pyNone();
  }

  private whileLoop(stmt: Statement & { type: 'While' }, env: Environment): MA<PyValue> {
    let result: PyValue = pyNone();
    let didBreak = false;

    while (true) {
      const testR = this.evaluate(stmt.test, env);
      if (testR instanceof Promise) {
        return testR.then(async (test) => {
          if (!isTruthy(test)) {
            if (stmt.orelse.length > 0) {
              const r = this.executeBlock(stmt.orelse, env);
              return r instanceof Promise ? await r : r;
            }
            return result;
          }
          return this.whileLoopAsync(stmt, env, result);
        });
      }
      if (!isTruthy(testR)) break;
      this.checkIterations(stmt.line, stmt.column);
      try {
        const br = this.executeBlock(stmt.body, env);
        if (br instanceof Promise) {
          return br.then(
            async () => this.whileLoopAsync(stmt, env, pyNone()),
            async (e: any) => {
              if (e instanceof BreakException) return pyNone() as PyValue;
              if (e instanceof ContinueException) return this.whileLoopAsync(stmt, env, pyNone());
              throw e;
            }
          );
        }
        result = br;
      } catch (e) {
        if (e instanceof BreakException) { didBreak = true; break; }
        if (e instanceof ContinueException) continue;
        throw e;
      }
    }

    if (!didBreak && stmt.orelse.length > 0) return this.executeBlock(stmt.orelse, env);
    return result;
  }

  private async whileLoopAsync(stmt: Statement & { type: 'While' }, env: Environment, result: PyValue): Promise<PyValue> {
    let didBreak = false;
    while (true) {
      const tr = this.evaluate(stmt.test, env);
      const test = tr instanceof Promise ? await tr : tr;
      if (!isTruthy(test)) break;
      this.checkIterations(stmt.line, stmt.column);
      try {
        const br = this.executeBlock(stmt.body, env);
        result = br instanceof Promise ? await br : br;
      } catch (e) {
        if (e instanceof BreakException) { didBreak = true; break; }
        if (e instanceof ContinueException) continue;
        throw e;
      }
    }
    if (!didBreak && stmt.orelse.length > 0) {
      const r = this.executeBlock(stmt.orelse, env);
      return r instanceof Promise ? await r : r;
    }
    return result;
  }

  // ── Try/except ────────────────────────────────────────────────────────────

  private executeTry(stmt: Statement & { type: 'Try' }, env: Environment): MA<PyValue> {
    try {
      const r = this.executeBlock(stmt.body, env);
      if (r instanceof Promise) {
        return r.then(
          (result) => this.tryElseFinally(stmt, result, null, env),
          (e) => this.tryCatch(stmt, e, env)
        );
      }
      return this.tryElseFinally(stmt, r, null, env);
    } catch (e) {
      return this.tryCatch(stmt, e as Error, env);
    }
  }

  private tryCatch(stmt: Statement & { type: 'Try' }, error: any, env: Environment): MA<PyValue> {
    if (error instanceof ReturnException || error instanceof BreakException || error instanceof ContinueException) {
      if (stmt.finalbody.length > 0) {
        const r = this.executeBlock(stmt.finalbody, env);
        if (r instanceof Promise) return r.then(() => { throw error; });
      }
      throw error;
    }

    let handled = false;
    for (const handler of stmt.handlers) {
      if (this.exceptionMatches(error, handler.exceptionTypes)) {
        handled = true;
        if (handler.name) {
          const errorMsg = (error as any).baseMessage || error.message;
          env.set(handler.name, pyString(errorMsg));
        }
        try {
          const r = this.executeBlock(handler.body, env);
          if (r instanceof Promise) {
            return r.then(
              (result) => this.tryFinally(stmt, result, env),
              (e2) => {
                if (stmt.finalbody.length > 0) {
                  const fr = this.executeBlock(stmt.finalbody, env);
                  if (fr instanceof Promise) return fr.then(() => { throw e2; });
                }
                throw e2;
              }
            );
          }
          return this.tryFinally(stmt, r, env);
        } catch (e2) {
          if (stmt.finalbody.length > 0) {
            const fr = this.executeBlock(stmt.finalbody, env);
            if (fr instanceof Promise) return fr.then(() => { throw e2; });
          }
          throw e2;
        }
      }
    }

    if (!handled) {
      if (stmt.finalbody.length > 0) {
        const fr = this.executeBlock(stmt.finalbody, env);
        if (fr instanceof Promise) return fr.then(() => { throw error; });
      }
      throw error;
    }
    return pyNone();
  }

  private tryElseFinally(
    stmt: Statement & { type: 'Try' }, result: PyValue, error: Error | null, env: Environment
  ): MA<PyValue> {
    let r = result;
    if (!error && stmt.orelse.length > 0) {
      const er = this.executeBlock(stmt.orelse, env);
      if (er instanceof Promise) {
        return er.then((elseResult) => this.tryFinally(stmt, elseResult, env));
      }
      r = er;
    }
    return this.tryFinally(stmt, r, env);
  }

  private tryFinally(stmt: Statement & { type: 'Try' }, result: PyValue, env: Environment): MA<PyValue> {
    if (stmt.finalbody.length > 0) {
      const fr = this.executeBlock(stmt.finalbody, env);
      return $(fr, () => result);
    }
    return result;
  }

  // ── Special builtins ──────────────────────────────────────────────────────

  private async handleSpecialBuiltin(
    name: string, args: PyValue[], kwargs: Record<string, PyValue>, line: number, column: number
  ): Promise<PyValue> {
    switch (name) {
      case 'sorted': {
        if (args.length === 0) throw new TypeError('sorted expected 1 argument, got 0', line, column);
        const iterable = args[0];
        let items: PyValue[];
        if (isList(iterable) || isTuple(iterable)) items = [...iterable.elements];
        else if (iterable.type === 'iterator') items = [...iterable.values];
        else if (iterable.type === 'generator') {
          const listVal = await this.exhaustGenerator(iterable);
          items = (listVal as any).elements;
        }
        else if (isString(iterable)) items = iterable.value.split('').map(c => pyString(c));
        else if (isDict(iterable)) {
          items = Array.from(iterable.entries.keys()).map(k =>
            typeof k === 'string' ? pyString(k) : typeof k === 'number' ? pyNumber(k) : pyBoolean(k as boolean)
          );
        }
        else throw new TypeError(`'${iterable.type}' object is not iterable`, line, column);
        const keyFunc = kwargs.key;
        const reverse = kwargs.reverse?.type === 'boolean' && (kwargs.reverse as any).value;
        if (keyFunc && (keyFunc.type === 'function' || keyFunc.type === 'builtin')) {
          const keyed: { item: PyValue; key: PyValue }[] = [];
          for (const item of items) {
            const kr = this.call(keyFunc, [item], {}, line, column);
            keyed.push({ item, key: kr instanceof Promise ? await kr : kr });
          }
          keyed.sort((a, b) => compareValues(a.key, b.key));
          items = keyed.map(x => x.item);
        } else {
          items.sort((a, b) => compareValues(a, b));
        }
        if (reverse) items.reverse();
        return pyList(items);
      }

      case 'min':
      case 'max': {
        const keyFunc = kwargs.key;
        let items: PyValue[];
        if (args.length === 1 && isIterable(args[0])) items = this.getIterableItems(args[0], line, column);
        else items = args;
        if (items.length === 0) throw new TypeError(`${name}() arg is an empty sequence`, line, column);
        const isMax = name === 'max';
        if (keyFunc && (keyFunc.type === 'function' || keyFunc.type === 'builtin')) {
          let best = items[0];
          let bestKeyR = this.call(keyFunc, [best], {}, line, column);
          let bestKey = bestKeyR instanceof Promise ? await bestKeyR : bestKeyR;
          for (let i = 1; i < items.length; i++) {
            const kr = this.call(keyFunc, [items[i]], {}, line, column);
            const k = kr instanceof Promise ? await kr : kr;
            if (isMax ? compareValues(k, bestKey) > 0 : compareValues(k, bestKey) < 0) {
              best = items[i]; bestKey = k;
            }
          }
          return best;
        }
        let best = items[0];
        for (let i = 1; i < items.length; i++) {
          if (isMax ? compareValues(items[i], best) > 0 : compareValues(items[i], best) < 0) best = items[i];
        }
        return best;
      }

      case 'map': {
        if (args.length < 2) throw new TypeError('map() requires at least 2 arguments', line, column);
        const func = args[0]; const iterable = args[1];
        let items: PyValue[];
        if (isList(iterable) || isTuple(iterable)) items = iterable.elements;
        else if (iterable.type === 'iterator') items = iterable.values;
        else if (isString(iterable)) items = iterable.value.split('').map(c => pyString(c));
        else throw new TypeError(`'${iterable.type}' object is not iterable`, line, column);
        const results: PyValue[] = [];
        for (const item of items) {
          const r = this.call(func, [item], {}, line, column);
          results.push(r instanceof Promise ? await r : r);
        }
        return pyIterator(results);
      }

      case 'filter': {
        if (args.length < 2) throw new TypeError('filter() requires 2 arguments', line, column);
        const func = args[0]; const iterable = args[1];
        let items: PyValue[];
        if (isList(iterable) || isTuple(iterable)) items = iterable.elements;
        else if (iterable.type === 'iterator') items = iterable.values;
        else if (isString(iterable)) items = iterable.value.split('').map(c => pyString(c));
        else throw new TypeError(`'${iterable.type}' object is not iterable`, line, column);
        const results: PyValue[] = [];
        for (const item of items) {
          let keep: boolean;
          if (func.type === 'none') { keep = isTruthy(item); }
          else {
            const r = this.call(func, [item], {}, line, column);
            keep = isTruthy(r instanceof Promise ? await r : r);
          }
          if (keep) results.push(item);
        }
        return pyIterator(results);
      }

      case 'next': {
        const iter = args[0]; const defaultVal = args[1];
        if (!iter) throw new TypeError('next() missing required argument', line, column);
        if (iter.type === 'generator') {
          const result = await iter.next();
          if (result.done) { if (defaultVal !== undefined) return defaultVal; throw new StopIteration(line, column); }
          return result.value;
        }
        if (iter.type === 'iterator') {
          if (iter.index >= iter.values.length) { if (defaultVal !== undefined) return defaultVal; throw new StopIteration(line, column); }
          return iter.values[iter.index++];
        }
        throw new TypeError(`'${iter.type}' object is not an iterator`, line, column);
      }

      case 'list': {
        const iterable = args[0];
        if (iterable === undefined) return pyList([]);
        if (iterable.type === 'generator') return await this.exhaustGenerator(iterable);
        return this.builtins.get('list')!.fn(iterable);
      }

      case 'enumerate': {
        if (args.length === 0) throw new TypeError('enumerate expected at least 1 argument, got 0', line, column);
        const iterable = args[0];
        let items: PyValue[];
        if (iterable.type === 'generator') {
          const listVal = await this.exhaustGenerator(iterable);
          items = (listVal as any).elements;
        } else if (isList(iterable) || isTuple(iterable)) items = iterable.elements;
        else if (iterable.type === 'iterator') items = iterable.values;
        else if (isString(iterable)) items = iterable.value.split('').map((c: string) => pyString(c));
        else throw new TypeError(`'${iterable.type}' object is not iterable`, line, column);
        const startVal = kwargs.start && isNumber(kwargs.start) ? (kwargs.start as any).value
          : (args[1] && isNumber(args[1]) ? (args[1] as any).value : 0);
        return pyIterator(items.map((item, i) => pyList([pyNumber(i + startVal), item])));
      }

      default:
        throw new TypeError(`Unknown special builtin: ${name}`, line, column);
    }
  }

  // ── Generator creation ────────────────────────────────────────────────────

  private createGenerator(name: string, body: Statement[], env: Environment): PyGenerator {
    let resolveYield: ((sendVal: PyValue) => void) | null = null;
    let resolveNext: ((result: { value: PyValue; done: boolean }) => void) | null = null;
    let started = false;
    let finished = false;
    const interpreter = this;

    const coroutine = async () => {
      try {
        const r = interpreter.executeBlock(body, env);
        if (r instanceof Promise) await r;
      } catch (e) {
        if (e instanceof ReturnException) { /* generator return = StopIteration */ }
        else throw e;
      }
      finished = true;
      if (resolveNext) { resolveNext({ value: pyNone(), done: true }); resolveNext = null; }
    };

    const yieldValue = (value: PyValue): Promise<PyValue> => {
      return new Promise<PyValue>((resolve) => {
        resolveYield = resolve;
        if (resolveNext) { resolveNext({ value, done: false }); resolveNext = null; }
      });
    };

    const gen: PyGenerator = {
      type: 'generator', name, started: false, finished: false,
      next: async (sendValue?: PyValue): Promise<{ value: PyValue; done: boolean }> => {
        if (finished || gen.finished) return { value: pyNone(), done: true };
        return new Promise<{ value: PyValue; done: boolean }>((resolve) => {
          resolveNext = resolve;
          if (!started) {
            started = true; gen.started = true;
            (env as any).__yieldFn = yieldValue;
            coroutine().catch((err) => {
              finished = true; gen.finished = true;
              if (resolveNext) resolveNext = null;
              resolve(Promise.reject(err) as any);
            });
          } else {
            if (resolveYield) { const resume = resolveYield; resolveYield = null; resume(sendValue ?? pyNone()); }
            else { finished = true; gen.finished = true; resolve({ value: pyNone(), done: true }); }
          }
        });
      },
    };

    (env as any).__yieldFn = yieldValue;
    return gen;
  }

  // ── Data access ───────────────────────────────────────────────────────────

  private subscript(obj: PyValue, index: PyValue, line: number, column: number): PyValue {
    if (isList(obj) || isTuple(obj)) {
      if (!isNumber(index)) throw new TypeError('list indices must be integers', line, column);
      let idx = Math.floor(index.value);
      if (idx < 0) idx = obj.elements.length + idx;
      if (idx < 0 || idx >= obj.elements.length) throw new IndexError('list index out of range', line, column);
      return obj.elements[idx];
    }
    if (isString(obj)) {
      if (!isNumber(index)) throw new TypeError('string indices must be integers', line, column);
      let idx = Math.floor(index.value);
      if (idx < 0) idx = obj.value.length + idx;
      if (idx < 0 || idx >= obj.value.length) throw new IndexError('string index out of range', line, column);
      return pyString(obj.value[idx]);
    }
    if (isDict(obj)) {
      if (!isString(index) && !isNumber(index) && !isBoolean(index)) throw new TypeError('unhashable type for dict key', line, column);
      const value = obj.entries.get(index.value);
      if (value === undefined) throw new KeyError(String(index.value), line, column);
      return value;
    }
    throw new TypeError(`'${obj.type}' object is not subscriptable`, line, column);
  }

  private slice(obj: PyValue, lower: PyValue | null, upper: PyValue | null, step: PyValue | null, line: number, column: number): PyValue {
    let start: number | undefined;
    let end: number | undefined;
    let stepVal = 1;
    if (lower !== null) { if (!isNumber(lower)) throw new TypeError('slice indices must be integers', line, column); start = lower.value; }
    if (upper !== null) { if (!isNumber(upper)) throw new TypeError('slice indices must be integers', line, column); end = upper.value; }
    if (step !== null) { if (!isNumber(step)) throw new TypeError('slice indices must be integers', line, column); stepVal = step.value; if (stepVal === 0) throw new TypeError('slice step cannot be zero', line, column); }

    if (isList(obj) || isTuple(obj)) {
      const len = obj.elements.length;
      const [s, e] = this.normalizeSliceIndices(start, end, stepVal, len);
      const result: PyValue[] = [];
      if (stepVal > 0) { for (let i = s; i < e; i += stepVal) result.push(obj.elements[i]); }
      else { for (let i = s; i > e; i += stepVal) result.push(obj.elements[i]); }
      return isList(obj) ? pyList(result) : pyTuple(result);
    }
    if (isString(obj)) {
      const len = obj.value.length;
      const [s, e] = this.normalizeSliceIndices(start, end, stepVal, len);
      let result = '';
      if (stepVal > 0) { for (let i = s; i < e; i += stepVal) result += obj.value[i]; }
      else { for (let i = s; i > e; i += stepVal) result += obj.value[i]; }
      return pyString(result);
    }
    throw new TypeError(`'${obj.type}' object is not subscriptable`, line, column);
  }

  private normalizeSliceIndices(start: number | undefined, end: number | undefined, step: number, len: number): [number, number] {
    if (step > 0) {
      return [
        start === undefined ? 0 : this.clampIndex(start, len),
        end === undefined ? len : this.clampIndex(end, len),
      ];
    }
    return [
      start === undefined ? len - 1 : this.clampIndex(start, len, true),
      end === undefined ? -1 : this.clampIndex(end, len, true),
    ];
  }

  private clampIndex(index: number, len: number, forNegativeStep = false): number {
    if (index < 0) index = len + index;
    if (forNegativeStep) return Math.max(-1, Math.min(len - 1, index));
    return Math.max(0, Math.min(len, index));
  }

  private getAttribute(obj: PyValue, attr: string, line: number, column: number): PyValue {
    if (isString(obj)) return getStringMethod(obj, attr, line, column);
    if (isList(obj)) return getListMethod(obj, attr, line, column);
    if (isDict(obj)) return getDictMethod(obj, attr, line, column);
    if (isSet(obj)) return getSetMethod(obj, attr, line, column);
    if (obj.type === 'builtin' && obj.name === 'dict' && attr === 'fromkeys') {
      return {
        type: 'builtin', name: 'dict.fromkeys',
        fn: (keys: PyValue, value?: PyValue) => {
          const defaultVal = value ?? pyNone();
          let items: PyValue[];
          if (isList(keys) || isTuple(keys)) items = keys.elements;
          else if (keys.type === 'iterator') items = keys.values;
          else if (isString(keys)) items = keys.value.split('').map((c: string) => pyString(c));
          else throw new TypeError(`'${keys.type}' object is not iterable`, line, column);
          const entries = new Map<string | number | boolean, PyValue>();
          for (const item of items) {
            if (!isString(item) && !isNumber(item) && !isBoolean(item)) throw new TypeError('unhashable type', line, column);
            entries.set(item.value, defaultVal);
          }
          return pyDict(entries);
        },
      };
    }
    throw new TypeError(`'${obj.type}' object has no attribute '${attr}'`, line, column);
  }

  private getIterableItems(value: PyValue, line: number, column: number): PyValue[] {
    if (isList(value) || isTuple(value)) return value.elements;
    if (value.type === 'iterator') return value.values;
    if (isString(value)) return value.value.split('').map(c => pyString(c));
    if (isDict(value)) {
      return Array.from(value.entries.keys()).map(k =>
        typeof k === 'string' ? pyString(k) : typeof k === 'number' ? pyNumber(k) : pyBoolean(k)
      );
    }
    if (isSet(value)) {
      return Array.from(value.values).map(v =>
        typeof v === 'string' ? pyString(v) : typeof v === 'number' ? pyNumber(v) : pyBoolean(v)
      );
    }
    throw new TypeError(`'${value.type}' object is not iterable`, line, column);
  }

  private async exhaustGenerator(gen: PyGenerator): Promise<PyValue> {
    const items: PyValue[] = [];
    let result = await gen.next();
    while (!result.done) { items.push(result.value); result = await gen.next(); }
    return pyList(items);
  }

  private findYieldFn(env: Environment): ((value: PyValue) => Promise<PyValue>) | null {
    let current: Environment | undefined = env;
    while (current) {
      if ((current as any).__yieldFn) return (current as any).__yieldFn;
      current = current.getParent();
    }
    return null;
  }

  private checkIterations(line: number, column: number): void {
    this.iterationCount++;
    if (this.iterationCount > this.maxIterations) throw new MaxIterationsError(line, column);
  }

  private exceptionMatches(error: Error, exceptionTypes: string[] | null): boolean {
    if (exceptionTypes === null) return true;
    const errorTypeMap: Record<string, string[]> = {
      'Exception': ['TypeError', 'NameError', 'KeyError', 'IndexError', 'ZeroDivisionError', 'ValueError', 'SyntaxError', 'AttributeError', 'StopIteration', 'InterpreterError'],
      'StopIteration': ['StopIteration'],
      'TypeError': ['TypeError'],
      'NameError': ['NameError'],
      'KeyError': ['KeyError'],
      'IndexError': ['IndexError'],
      'ZeroDivisionError': ['ZeroDivisionError'],
      'ValueError': ['ValueError'],
      'SyntaxError': ['SyntaxError'],
      'AttributeError': ['AttributeError'],
    };
    const errorTypeName = error.constructor.name;
    for (const exceptionType of exceptionTypes) {
      const matchingTypes = errorTypeMap[exceptionType] || [exceptionType];
      if (matchingTypes.includes(errorTypeName)) return true;
    }
    return false;
  }
}

// ── Format spec ─────────────────────────────────────────────────────────────

function applyFormatSpec(value: PyValue, spec: string): string {
  const match = spec.match(/^([<>=^])?(\+|-| )?(#)?(0)?(\d+)?([_,])?(\.(\d+))?([bcdeEfFgGnosxX%])?$/);
  if (!match) return pyStr(value);
  const [, align, , , zero, widthStr, , , precisionStr, typeChar] = match;
  const width = widthStr ? parseInt(widthStr) : 0;
  const precision = precisionStr !== undefined ? parseInt(precisionStr) : undefined;
  let formatted: string;
  const num = isNumber(value) ? value.value : NaN;
  switch (typeChar) {
    case 'f': case 'F': formatted = (isNaN(num) ? 0 : num).toFixed(precision ?? 6); break;
    case 'd': formatted = String(Math.trunc(isNaN(num) ? 0 : num)); break;
    case 'b': formatted = Math.trunc(isNaN(num) ? 0 : num).toString(2); break;
    case 'o': formatted = Math.trunc(isNaN(num) ? 0 : num).toString(8); break;
    case 'x': formatted = Math.trunc(isNaN(num) ? 0 : num).toString(16); break;
    case 'X': formatted = Math.trunc(isNaN(num) ? 0 : num).toString(16).toUpperCase(); break;
    case 'e': formatted = (isNaN(num) ? 0 : num).toExponential(precision ?? 6); break;
    case 'E': formatted = (isNaN(num) ? 0 : num).toExponential(precision ?? 6).toUpperCase(); break;
    case 's': case undefined:
      if (precision !== undefined && isString(value)) formatted = value.value.slice(0, precision);
      else if (precision !== undefined && !isNaN(num)) formatted = num.toFixed(precision);
      else formatted = pyStr(value);
      break;
    default: formatted = pyStr(value);
  }
  if (width > formatted.length) {
    const fill = zero ? '0' : ' ';
    const effectiveAlign = align || (zero ? '=' : (isNaN(num) ? '<' : '>'));
    const pad = width - formatted.length;
    switch (effectiveAlign) {
      case '<': formatted = formatted + fill.repeat(pad); break;
      case '>': formatted = fill.repeat(pad) + formatted; break;
      case '^': { const left = Math.floor(pad / 2); formatted = fill.repeat(left) + formatted + fill.repeat(pad - left); break; }
      default: formatted = fill.repeat(pad) + formatted;
    }
  }
  return formatted;
}

function isKwargsValue(value: PyValue): value is PyKwargs {
  return typeof value === 'object' && value !== null && (value as any).type === 'kwargs';
}

export function createInterpreter(options?: InterpreterOptions): Interpreter {
  return new Interpreter(options);
}
