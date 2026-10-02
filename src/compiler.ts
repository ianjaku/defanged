/**
 * Compiles the AST to bytecode for the VM.
 *
 * Two passes: `analyze` decides where every name lives (local slot, closure
 * cell or global) and `CodeGen` emits one Code object per function.
 */

import {
  Program,
  Statement,
  Expression,
  Comprehension,
  Signature,
  FStringPart,
  FunctionDef,
  Lambda,
  Try,
} from './ast';
import { SyntaxError } from './errors';
import { PyFloat } from './numbers';
import { ELLIPSIS, Globals } from './values';
import { Op, BinOp, CmpOp, UnOp } from './vm';

/** One compiled function body (or the module body). */
export interface Code {
  name: string;
  ops: number[];
  args: number[];
  /** Source position of each instruction, for error messages. */
  lines: number[];
  cols: number[];
  consts: any[];
  names: string[];
  /** Local slot names; parameters come first, in binding order. */
  varNames: string[];
  /** Cell names: variables captured by inner functions, then free variables. */
  cellNames: string[];
  /** How many of cellNames are this function's own variables. */
  ownCells: number;
  /** [local slot, cell index] for each parameter that is also a cell. */
  cellParams: number[];
  /** Positional-or-keyword parameter count. */
  argCount: number;
  kwOnlyCount: number;
  hasVarArgs: boolean;
  hasKwargs: boolean;
  /** True when a call can bind arguments by position alone: no *args,
   *  **kwargs or keyword-only parameters. */
  simpleArgs: boolean;
  isGenerator: boolean;
  /** Comprehension bodies do not count toward the recursion limit. */
  isComprehension: boolean;
  /** Exception table, innermost first: [start, end, handler, stackDepth]. */
  handlers: number[];
}

/** What MAKE_FUNCTION needs besides the defaults on the stack. */
export interface FunctionProto {
  code: Code;
  /** Number of positional defaults pushed before MAKE_FUNCTION. */
  defaultCount: number;
  /** Keyword-only parameters whose defaults were pushed, in push order. */
  kwDefaultNames: string[];
  /** Cell indices in the defining frame that become the closure. */
  freeCells: number[];
}

// ── Scope analysis ──────────────────────────────────────────────────────────

type ScopeNode = Program | FunctionDef | Lambda | Expression;

class Scope {
  bound = new Set<string>();
  used = new Set<string>();
  globals = new Set<string>();
  nonlocals = new Set<string>();
  /** Own variables that an inner function captures. */
  cells = new Set<string>();
  /** Variables captured from an enclosing function. */
  frees = new Set<string>();
  isGenerator = false;

  constructor(
    public readonly kind: 'module' | 'function' | 'comprehension',
    public readonly parent: Scope | null,
  ) {}
}

class Analyzer {
  readonly scopes = new Map<ScopeNode, Scope>();
  private readonly all: Scope[] = [];

  analyze(program: Program): void {
    const module = this.newScope(program, 'module', null);
    this.statements(program, module);
    for (const scope of this.all) {
      for (const name of scope.used) this.resolveFree(scope, name);
      for (const name of scope.nonlocals) {
        if (!this.resolveFree(scope, name)) {
          throw new SyntaxError(`no binding for nonlocal '${name}' found`, 0, 0);
        }
      }
    }
  }

  private newScope(node: ScopeNode, kind: Scope['kind'], parent: Scope | null): Scope {
    const scope = new Scope(kind, parent);
    this.scopes.set(node, scope);
    this.all.push(scope);
    return scope;
  }

  /** Marks `name` as captured from an enclosing function, if one binds it. */
  private resolveFree(scope: Scope, name: string): boolean {
    if (scope.kind === 'module' || scope.globals.has(name)) return false;
    if (scope.bound.has(name) && !scope.nonlocals.has(name)) return false;
    const between: Scope[] = [];
    for (let p = scope.parent; p && p.kind !== 'module'; p = p.parent) {
      if (p.globals.has(name)) return false;
      if (p.bound.has(name) && !p.nonlocals.has(name)) {
        p.cells.add(name);
        scope.frees.add(name);
        for (const s of between) s.frees.add(name);
        return true;
      }
      between.push(p);
    }
    return false;
  }

  private statements(stmts: Statement[], scope: Scope): void {
    for (const stmt of stmts) this.statement(stmt, scope);
  }

  private statement(stmt: Statement, scope: Scope): void {
    switch (stmt.type) {
      case 'ExpressionStmt':
        this.expr(stmt.expression, scope);
        break;
      case 'Assignment':
        this.expr(stmt.value, scope);
        for (const target of stmt.targets) this.bind(target, scope);
        break;
      case 'AugmentedAssignment':
        this.expr(stmt.target, scope);
        this.expr(stmt.value, scope);
        this.bind(stmt.target, scope);
        break;
      case 'If':
        this.expr(stmt.test, scope);
        this.statements(stmt.body, scope);
        this.statements(stmt.orelse, scope);
        break;
      case 'For':
        this.expr(stmt.iter, scope);
        this.bind(stmt.target, scope);
        this.statements(stmt.body, scope);
        this.statements(stmt.orelse, scope);
        break;
      case 'While':
        this.expr(stmt.test, scope);
        this.statements(stmt.body, scope);
        this.statements(stmt.orelse, scope);
        break;
      case 'FunctionDef': {
        for (const d of stmt.decorators) this.expr(d, scope);
        this.bindName(stmt.name, scope);
        const fn = this.signature(stmt, stmt, scope);
        this.statements(stmt.body, fn);
        break;
      }
      case 'Return':
        if (stmt.value) this.expr(stmt.value, scope);
        break;
      case 'Raise':
        if (stmt.value) this.expr(stmt.value, scope);
        if (stmt.cause) this.expr(stmt.cause, scope);
        break;
      case 'Try':
        this.statements(stmt.body, scope);
        for (const handler of stmt.handlers) {
          for (const name of handler.exceptionTypes ?? []) scope.used.add(name.split('.')[0]);
          if (handler.name) this.bindName(handler.name, scope);
          this.statements(handler.body, scope);
        }
        this.statements(stmt.orelse, scope);
        this.statements(stmt.finalbody, scope);
        break;
      case 'Global':
        for (const name of stmt.names) scope.globals.add(name);
        break;
      case 'Nonlocal':
        if (scope.kind === 'module') {
          throw new SyntaxError('nonlocal declaration not allowed at module level', stmt.line, stmt.column);
        }
        for (const name of stmt.names) scope.nonlocals.add(name);
        break;
      case 'Del':
        for (const target of stmt.targets) {
          this.expr(target, scope);
          this.bind(target, scope);
        }
        break;
      case 'Assert':
        this.expr(stmt.test, scope);
        if (stmt.msg) this.expr(stmt.msg, scope);
        break;
      case 'Import':
        for (const { name, alias } of stmt.modules) this.bindName(alias ?? name.split('.')[0], scope);
        break;
      case 'ImportFrom':
        if (stmt.names === '*') {
          if (scope.kind !== 'module') {
            throw new SyntaxError('import * only allowed at module level', stmt.line, stmt.column);
          }
        } else {
          for (const { name, alias } of stmt.names) this.bindName(alias ?? name, scope);
        }
        break;
      case 'Break': case 'Continue': case 'Pass':
        break;
    }
  }

  /** Creates the scope for a def/lambda; defaults belong to the outer scope. */
  private signature(node: FunctionDef | Lambda, sig: Signature, outer: Scope): Scope {
    const fn = this.newScope(node, 'function', outer);
    for (const p of [...sig.params, ...sig.kwOnlyParams]) {
      if (p.default) this.expr(p.default, outer);
      fn.bound.add(p.name);
    }
    if (sig.restParam) fn.bound.add(sig.restParam);
    if (sig.kwargsParam) fn.bound.add(sig.kwargsParam);
    return fn;
  }

  private bindName(name: string, scope: Scope): void {
    scope.bound.add(name);
  }

  private bind(target: Expression, scope: Scope): void {
    switch (target.type) {
      case 'Identifier':
        this.bindName(target.name, scope);
        break;
      case 'Tuple': case 'List':
        for (const el of target.elements) this.bind(el, scope);
        break;
      case 'Starred':
        this.bind(target.value, scope);
        break;
      default:
        // Subscript / attribute / slice targets bind nothing; their
        // sub-expressions are plain uses.
        this.expr(target, scope);
    }
  }

  private comprehension(node: Expression, generators: Comprehension[], elements: Expression[], outer: Scope): void {
    // The first iterable is evaluated by the enclosing scope and passed in.
    this.expr(generators[0].iter, outer);
    const scope = this.newScope(node, 'comprehension', outer);
    if (node.type === 'GeneratorExp') scope.isGenerator = true;
    generators.forEach((gen, i) => {
      if (i > 0) this.expr(gen.iter, scope);
      this.bind(gen.target, scope);
      for (const cond of gen.conditions) this.expr(cond, scope);
    });
    for (const el of elements) this.expr(el, scope);
  }

  private expr(e: Expression, scope: Scope): void {
    switch (e.type) {
      case 'Number': case 'String': case 'Boolean': case 'None': case 'Ellipsis':
        break;
      case 'Identifier':
        scope.used.add(e.name);
        break;
      case 'BinaryOp': case 'BooleanOp':
        this.expr(e.left, scope);
        this.expr(e.right, scope);
        break;
      case 'UnaryOp':
        this.expr(e.operand, scope);
        break;
      case 'Compare':
        this.expr(e.left, scope);
        for (const c of e.comparators) this.expr(c, scope);
        break;
      case 'Call':
        this.expr(e.func, scope);
        for (const a of e.args) this.expr(a, scope);
        for (const kw of e.kwargs) this.expr(kw.value, scope);
        for (const d of e.doubleStarArgs ?? []) this.expr(d, scope);
        break;
      case 'Subscript':
        this.expr(e.object, scope);
        this.expr(e.index, scope);
        break;
      case 'Slice':
        this.expr(e.object, scope);
        if (e.lower) this.expr(e.lower, scope);
        if (e.upper) this.expr(e.upper, scope);
        if (e.step) this.expr(e.step, scope);
        break;
      case 'Attribute':
        this.expr(e.object, scope);
        break;
      case 'List': case 'Tuple': case 'Set':
        for (const el of e.elements) this.expr(el, scope);
        break;
      case 'Dict':
        for (const k of e.keys) if (k) this.expr(k, scope);
        for (const v of e.values) this.expr(v, scope);
        break;
      case 'ListComp': case 'SetComp': case 'GeneratorExp':
        this.comprehension(e, e.generators, [e.element], scope);
        break;
      case 'DictComp':
        this.comprehension(e, e.generators, [e.key, e.value], scope);
        break;
      case 'Ternary':
        this.expr(e.test, scope);
        this.expr(e.consequent, scope);
        this.expr(e.alternate, scope);
        break;
      case 'Lambda': {
        const fn = this.signature(e, e, scope);
        this.expr(e.body, fn);
        break;
      }
      case 'FString':
        this.fstringParts(e.parts, scope);
        break;
      case 'NamedExpr': {
        this.expr(e.value, scope);
        // A walrus inside a comprehension binds in the enclosing function.
        let owner = scope;
        while (owner.kind === 'comprehension') owner = owner.parent!;
        for (let s = scope; s !== owner; s = s.parent!) {
          (owner.kind === 'module' ? s.globals : s.nonlocals).add(e.target);
        }
        owner.bound.add(e.target);
        break;
      }
      case 'Starred':
        this.expr(e.value, scope);
        break;
      case 'Yield':
        if (scope.kind === 'module') throw new SyntaxError("'yield' outside function", e.line, e.column);
        scope.isGenerator = true;
        if (e.value) this.expr(e.value, scope);
        break;
      case 'YieldFrom':
        if (scope.kind === 'module') throw new SyntaxError("'yield' outside function", e.line, e.column);
        scope.isGenerator = true;
        this.expr(e.value, scope);
        break;
    }
  }

  private fstringParts(parts: FStringPart[], scope: Scope): void {
    for (const part of parts) {
      if (part.expr) this.expr(part.expr, scope);
      if (part.specParts) this.fstringParts(part.specParts, scope);
    }
  }
}

// ── Code generation ─────────────────────────────────────────────────────────

const BINARY_OPS: Record<string, BinOp> = {
  '+': BinOp.ADD, '-': BinOp.SUB, '*': BinOp.MUL, '/': BinOp.DIV, '//': BinOp.FLOORDIV,
  '%': BinOp.MOD, '**': BinOp.POW, '&': BinOp.AND, '|': BinOp.OR, '^': BinOp.XOR,
  '<<': BinOp.LSHIFT, '>>': BinOp.RSHIFT,
};

const COMPARE_OPS: Record<string, CmpOp> = {
  '==': CmpOp.EQ, '!=': CmpOp.NE, '<': CmpOp.LT, '>': CmpOp.GT, '<=': CmpOp.LE, '>=': CmpOp.GE,
  'in': CmpOp.IN, 'not in': CmpOp.NOT_IN, 'is': CmpOp.IS, 'is not': CmpOp.IS_NOT,
};

interface Label {
  pc: number;
  /** Instructions that jump here, patched once the label is placed. */
  refs: number[];
}

type PcRange = [start: number, end: number];

/** What `break`, `continue` and `return` have to unwind on their way out. */
type Block =
  | { kind: 'loop'; isFor: boolean; breakLabel: Label; continueLabel: Label }
  /** A try body: `skipped` holds inlined finally code its handler must not cover. */
  | { kind: 'try'; skipped: PcRange[] }
  | { kind: 'finally'; body: Statement[]; skipped: PcRange[] };

class CodeGen {
  readonly code: Code;
  private readonly locals = new Map<string, number>();
  private readonly cellIndex = new Map<string, number>();
  private readonly constIndex = new Map<unknown, number>();
  private readonly nameIndex = new Map<string, number>();
  private blocks: Block[] = [];
  /** `for` loops enclosing the current statement; each keeps its iterator on the stack. */
  private forDepth = 0;
  /** Slots holding the exception of each enclosing `except` body. */
  private handlerSlots: number[] = [];
  private line = 0;
  private col = 0;

  constructor(
    private readonly scope: Scope,
    private readonly scopes: Map<ScopeNode, Scope>,
    private readonly globals: Globals,
    name: string,
    /** Top-level statements whose value is the result of `run()`. */
    private readonly resultStmts: Set<Statement> | null,
  ) {
    this.code = {
      name, ops: [], args: [], lines: [], cols: [], consts: [], names: [], varNames: [],
      cellNames: [], ownCells: 0, cellParams: [], argCount: 0, kwOnlyCount: 0,
      hasVarArgs: false, hasKwargs: false, simpleArgs: true, isGenerator: scope.isGenerator,
      isComprehension: scope.kind === 'comprehension', handlers: [],
    };
  }

  // ── Emission helpers ──────────────────────────────────────────────────────

  private at(node: { line: number; column: number }): void {
    this.line = node.line;
    this.col = node.column;
  }

  private emit(op: Op, arg: number = 0): number {
    const { code } = this;
    code.ops.push(op);
    code.args.push(arg);
    code.lines.push(this.line);
    code.cols.push(this.col);
    return code.ops.length - 1;
  }

  private get pc(): number {
    return this.code.ops.length;
  }

  private label(): Label {
    return { pc: -1, refs: [] };
  }

  private place(label: Label): void {
    label.pc = this.pc;
    for (const ref of label.refs) this.code.args[ref] = label.pc;
  }

  private jump(op: Op, label: Label): void {
    const at = this.emit(op, label.pc);
    if (label.pc < 0) label.refs.push(at);
  }

  private constant(value: unknown): number {
    // Equal literals share one constant, as in CPython (`3.0 is 3.0`);
    // other objects (function prototypes, name lists) are never shared.
    let key: unknown = value;
    if (value instanceof PyFloat) key = `f${Object.is(value.v, -0) ? '-0' : value.v}`;
    else if (typeof value === 'bigint') key = `n${value}`;
    else if (typeof value === 'string') key = `s${value}`;
    else if (typeof value === 'object' && value !== null) key = undefined;
    if (key !== undefined) {
      const existing = this.constIndex.get(key);
      if (existing !== undefined) return existing;
    }
    this.code.consts.push(value);
    const index = this.code.consts.length - 1;
    if (key !== undefined) this.constIndex.set(key, index);
    return index;
  }

  private loadConst(value: unknown): void {
    this.emit(Op.LOAD_CONST, this.constant(value));
  }

  private name(name: string): number {
    let index = this.nameIndex.get(name);
    if (index === undefined) {
      this.code.names.push(name);
      this.nameIndex.set(name, (index = this.code.names.length - 1));
    }
    return index;
  }

  private local(name: string): number {
    let slot = this.locals.get(name);
    if (slot === undefined) {
      this.code.varNames.push(name);
      this.locals.set(name, (slot = this.code.varNames.length - 1));
    }
    return slot;
  }

  /** A hidden local, for values the compiler has to park (exceptions, return values). */
  private temp(): number {
    this.code.varNames.push(`.t${this.code.varNames.length}`);
    return this.code.varNames.length - 1;
  }

  // ── Names ─────────────────────────────────────────────────────────────────

  private setUpCells(): void {
    for (const name of this.scope.cells) {
      this.cellIndex.set(name, this.code.cellNames.length);
      this.code.cellNames.push(name);
    }
    this.code.ownCells = this.code.cellNames.length;
    for (const name of this.scope.frees) {
      this.cellIndex.set(name, this.code.cellNames.length);
      this.code.cellNames.push(name);
    }
  }

  private access(name: string, fast: Op, deref: Op, global: Op): void {
    const { scope } = this;
    if (scope.kind !== 'module' && !scope.globals.has(name)) {
      const cell = this.cellIndex.get(name);
      if (cell !== undefined) {
        this.emit(deref, cell);
        return;
      }
      if (scope.bound.has(name)) {
        this.emit(fast, this.local(name));
        return;
      }
    }
    this.emit(global, this.globals.slot(name));
  }

  private load(name: string): void {
    this.access(name, Op.LOAD_FAST, Op.LOAD_DEREF, Op.LOAD_GLOBAL);
  }

  private store(name: string): void {
    this.access(name, Op.STORE_FAST, Op.STORE_DEREF, Op.STORE_GLOBAL);
  }

  private delete(name: string): void {
    this.access(name, Op.DELETE_FAST, Op.DELETE_DEREF, Op.DELETE_GLOBAL);
  }

  // ── Functions ─────────────────────────────────────────────────────────────

  /** Declares parameters in binding order: positional, keyword-only, *args, **kwargs. */
  private declareParams(sig: Signature): void {
    const { code } = this;
    let sawDefault = false;
    for (const p of sig.params) {
      if (p.default) sawDefault = true;
      else if (sawDefault) {
        throw new SyntaxError('parameter without a default follows parameter with a default', this.line, this.col);
      }
      this.declareParam(p.name);
    }
    for (const p of sig.kwOnlyParams) this.declareParam(p.name);
    if (sig.restParam) this.declareParam(sig.restParam);
    if (sig.kwargsParam) this.declareParam(sig.kwargsParam);
    code.argCount = sig.params.length;
    code.kwOnlyCount = sig.kwOnlyParams.length;
    code.hasVarArgs = sig.restParam !== undefined;
    code.hasKwargs = sig.kwargsParam !== undefined;
    code.simpleArgs = !code.hasVarArgs && !code.hasKwargs && code.kwOnlyCount === 0;
  }

  private declareParam(name: string): void {
    if (this.locals.has(name)) {
      throw new SyntaxError(`duplicate argument '${name}' in function definition`, this.line, this.col);
    }
    const slot = this.local(name);
    const cell = this.cellIndex.get(name);
    if (cell !== undefined) this.code.cellParams.push(slot, cell);
  }

  /** Emits code that leaves a new function object on the stack. */
  private makeFunction(node: FunctionDef | Lambda, name: string): void {
    const sig: Signature = node;
    const scope = this.scopes.get(node)!;
    const gen = new CodeGen(scope, this.scopes, this.globals, name, null);
    gen.at(node);
    gen.setUpCells();
    gen.declareParams(sig);
    if (node.type === 'Lambda') {
      gen.expression(node.body);
      gen.emit(Op.RETURN);
    } else {
      gen.statements(node.body);
      gen.loadConst(null);
      gen.emit(Op.RETURN);
    }

    let defaultCount = 0;
    for (const p of sig.params) {
      if (p.default) {
        this.expression(p.default);
        defaultCount++;
      }
    }
    const kwDefaultNames: string[] = [];
    for (const p of sig.kwOnlyParams) {
      if (p.default) {
        this.expression(p.default);
        kwDefaultNames.push(p.name);
      }
    }
    this.at(node);
    this.emitMakeFunction(gen, defaultCount, kwDefaultNames);
  }

  private emitMakeFunction(gen: CodeGen, defaultCount: number, kwDefaultNames: string[]): void {
    const freeCells = gen.code.cellNames.slice(gen.code.ownCells).map((n) => this.cellIndex.get(n)!);
    const proto: FunctionProto = { code: gen.code, defaultCount, kwDefaultNames, freeCells };
    this.emit(Op.MAKE_FUNCTION, this.constant(proto));
  }

  // ── Statements ────────────────────────────────────────────────────────────

  module(program: Program): Code {
    this.statements(program);
    this.emit(Op.LOAD_RESULT);
    this.emit(Op.RETURN);
    return this.code;
  }

  private statements(stmts: Statement[]): void {
    for (const stmt of stmts) this.statement(stmt);
  }

  private statement(stmt: Statement): void {
    this.at(stmt);
    const isResult = this.resultStmts !== null && this.resultStmts.has(stmt);

    switch (stmt.type) {
      case 'ExpressionStmt':
        this.expression(stmt.expression);
        this.emit(isResult ? Op.STORE_RESULT : Op.POP);
        return;

      case 'Assignment':
        this.expression(stmt.value);
        stmt.targets.forEach((target, i) => {
          if (i < stmt.targets.length - 1) this.emit(Op.DUP);
          this.assign(target);
        });
        break;

      case 'AugmentedAssignment':
        this.augmentedAssignment(stmt.target, stmt.op.slice(0, -1), stmt.value);
        break;

      case 'If': {
        const orelse = this.label();
        const end = this.label();
        this.condition(stmt.test, orelse);
        this.statements(stmt.body);
        if (stmt.orelse.length > 0) {
          this.jump(Op.JUMP, end);
          this.place(orelse);
          this.statements(stmt.orelse);
        } else {
          this.place(orelse);
        }
        this.place(end);
        return;
      }

      case 'For': {
        const top = this.label();
        const exhausted = this.label();
        const end = this.label();
        this.expression(stmt.iter);
        this.at(stmt);
        this.emit(Op.GET_ITER);
        this.place(top);
        this.jump(Op.FOR_ITER, exhausted);
        this.forDepth++;
        this.assign(stmt.target);
        this.blocks.push({ kind: 'loop', isFor: true, breakLabel: end, continueLabel: top });
        this.statements(stmt.body);
        this.blocks.pop();
        this.forDepth--;
        this.jump(Op.JUMP, top);
        this.place(exhausted);
        this.statements(stmt.orelse);
        this.place(end);
        return;
      }

      case 'While': {
        const top = this.label();
        const orelse = this.label();
        const end = this.label();
        this.place(top);
        this.condition(stmt.test, orelse);
        this.blocks.push({ kind: 'loop', isFor: false, breakLabel: end, continueLabel: top });
        this.statements(stmt.body);
        this.blocks.pop();
        this.at(stmt);
        this.jump(Op.JUMP_LOOP, top);
        this.place(orelse);
        this.statements(stmt.orelse);
        this.place(end);
        return;
      }

      case 'FunctionDef':
        for (const d of stmt.decorators) this.expression(d);
        this.makeFunction(stmt, stmt.name);
        for (let i = 0; i < stmt.decorators.length; i++) this.emit(Op.CALL, 1);
        this.store(stmt.name);
        break;

      case 'Return': {
        if (this.scope.kind === 'module') throw new SyntaxError("'return' outside function", stmt.line, stmt.column);
        if (stmt.value) this.expression(stmt.value);
        else this.loadConst(null);
        if (this.blocks.some((b) => b.kind === 'finally')) {
          // Park the value while the finally blocks run, so they see a clean stack.
          const slot = this.temp();
          this.emit(Op.STORE_FAST, slot);
          this.unwind(0);
          this.emit(Op.LOAD_FAST, slot);
        }
        this.at(stmt);
        this.emit(Op.RETURN);
        return;
      }

      case 'Break':
      case 'Continue': {
        const loopIndex = this.findLoop();
        if (loopIndex < 0) {
          const what = stmt.type === 'Break' ? "'break' outside loop" : "'continue' not properly in loop";
          throw new SyntaxError(what, stmt.line, stmt.column);
        }
        const loop = this.blocks[loopIndex] as Block & { kind: 'loop' };
        this.unwind(loopIndex + 1);
        if (stmt.type === 'Break') {
          if (loop.isFor) this.emit(Op.POP);
          this.jump(Op.JUMP, loop.breakLabel);
        } else {
          this.jump(loop.isFor ? Op.JUMP : Op.JUMP_LOOP, loop.continueLabel);
        }
        return;
      }

      case 'Pass':
        break;

      case 'Raise':
        if (stmt.value) {
          this.expression(stmt.value);
          if (stmt.cause) {
            this.expression(stmt.cause);
            this.emit(Op.POP);
          }
          this.at(stmt);
          this.emit(Op.RAISE);
        } else if (this.handlerSlots.length > 0) {
          this.emit(Op.LOAD_FAST, this.handlerSlots[this.handlerSlots.length - 1]);
          this.emit(Op.RERAISE);
        } else {
          this.emit(Op.RERAISE_NONE);
        }
        return;

      case 'Try':
        this.tryStatement(stmt);
        return;

      case 'Global':
      case 'Nonlocal':
        break;

      case 'Del':
        for (const target of stmt.targets) this.deleteTarget(target);
        break;

      case 'Assert': {
        const ok = this.label();
        this.expression(stmt.test);
        this.jump(Op.POP_JUMP_IF_TRUE, ok);
        if (stmt.msg) this.expression(stmt.msg);
        this.at(stmt);
        this.emit(Op.RAISE_ASSERT, stmt.msg ? 1 : 0);
        this.place(ok);
        break;
      }

      case 'Import':
        for (const { name, alias } of stmt.modules) {
          this.emit(Op.IMPORT_NAME, this.name(name));
          this.store(alias ?? name.split('.')[0]);
        }
        break;

      case 'ImportFrom':
        this.emit(Op.IMPORT_NAME, this.name(stmt.module));
        if (stmt.names === '*') {
          this.emit(Op.IMPORT_STAR);
        } else {
          for (const { name, alias } of stmt.names) {
            this.emit(Op.IMPORT_FROM, this.name(name));
            this.store(alias ?? name);
          }
          this.emit(Op.POP);
        }
        break;
    }

    // A statement that is not an expression leaves `run()` with no result.
    if (isResult) this.emit(Op.CLEAR_RESULT);
  }

  private findLoop(): number {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      if (this.blocks[i].kind === 'loop') return i;
    }
    return -1;
  }

  /** Runs the `finally` bodies of the blocks from the innermost down to
   *  `downTo`, as `break`/`continue`/`return` leave them. An error inside an
   *  inlined copy must not run that same `finally` again. */
  private unwind(downTo: number): void {
    const saved = this.blocks;
    const forDepth = this.forDepth;
    for (let i = saved.length - 1; i >= downTo; i--) {
      const block = saved[i];
      if (block.kind === 'loop') {
        // A `return` leaves this loop: drop its iterator, so a `break` in an
        // outer `finally` finds the stack it expects.
        if (block.isFor) {
          this.emit(Op.POP);
          this.forDepth--;
        }
        continue;
      }
      if (block.kind !== 'finally') continue;
      const start = this.pc;
      this.blocks = saved.slice(0, i);
      this.statements(block.body);
      this.blocks = saved;
      const range: PcRange = [start, this.pc];
      for (let j = i; j < saved.length; j++) {
        const inner = saved[j];
        if (inner.kind !== 'loop') inner.skipped.push(range);
      }
    }
    this.forDepth = forDepth;
  }

  /** Adds an exception-table entry for [start, end) minus the skipped ranges. */
  private addHandler(start: number, end: number, skipped: PcRange[], handlerPc: number): void {
    let from = start;
    for (const [s, e] of skipped) {
      if (s > from) this.code.handlers.push(from, s, handlerPc, this.forDepth);
      from = Math.max(from, e);
    }
    if (end > from) this.code.handlers.push(from, end, handlerPc, this.forDepth);
  }

  private tryStatement(stmt: Try): void {
    const hasFinally = stmt.finalbody.length > 0;
    const finallyBlock: Block & { kind: 'finally' } = { kind: 'finally', body: stmt.finalbody, skipped: [] };
    if (hasFinally) this.blocks.push(finallyBlock);

    const start = this.pc;
    const afterHandlers = this.label();

    if (stmt.handlers.length > 0) {
      const tryBlock: Block & { kind: 'try' } = { kind: 'try', skipped: [] };
      this.blocks.push(tryBlock);
      this.statements(stmt.body);
      this.blocks.pop();
      const bodyEnd = this.pc;
      this.statements(stmt.orelse);
      this.jump(Op.JUMP, afterHandlers);

      this.addHandler(start, bodyEnd, tryBlock.skipped, this.pc);
      const excSlot = this.temp();
      this.emit(Op.STORE_FAST, excSlot);
      for (const handler of stmt.handlers) {
        this.at(handler);
        const next = this.label();
        if (handler.exceptionTypes !== null) {
          this.emit(Op.LOAD_FAST, excSlot);
          for (const typeName of handler.exceptionTypes) {
            const [head, ...attrs] = typeName.split('.');
            this.load(head);
            for (const attr of attrs) this.emit(Op.LOAD_ATTR, this.name(attr));
          }
          if (handler.exceptionTypes.length > 1) this.emit(Op.BUILD_TUPLE, handler.exceptionTypes.length);
          this.emit(Op.EXC_MATCH);
          this.jump(Op.POP_JUMP_IF_FALSE, next);
        }
        if (handler.name) {
          this.emit(Op.LOAD_FAST, excSlot);
          this.store(handler.name);
        }
        this.handlerSlots.push(excSlot);
        this.statements(handler.body);
        this.handlerSlots.pop();
        if (handler.name) {
          // Like CPython, the name is unbound once the handler finishes.
          this.loadConst(null);
          this.store(handler.name);
          this.delete(handler.name);
        }
        this.jump(Op.JUMP, afterHandlers);
        this.place(next);
      }
      // No handler matched: keep propagating.
      this.emit(Op.LOAD_FAST, excSlot);
      this.emit(Op.RERAISE);
    } else {
      this.statements(stmt.body);
    }
    this.place(afterHandlers);

    if (hasFinally) {
      this.blocks.pop();
      const coveredEnd = this.pc;
      const end = this.label();
      this.statements(stmt.finalbody);
      this.jump(Op.JUMP, end);

      this.addHandler(start, coveredEnd, finallyBlock.skipped, this.pc);
      const excSlot = this.temp();
      this.emit(Op.STORE_FAST, excSlot);
      this.statements(stmt.finalbody);
      this.emit(Op.LOAD_FAST, excSlot);
      this.emit(Op.RERAISE);
      this.place(end);
    }
  }

  // ── Assignment targets ────────────────────────────────────────────────────

  /** Stores the value on top of the stack into `target`. */
  private assign(target: Expression): void {
    switch (target.type) {
      case 'Identifier':
        this.at(target);
        this.store(target.name);
        return;

      case 'Tuple':
      case 'List': {
        const starIndex = target.elements.findIndex((e) => e.type === 'Starred');
        this.at(target);
        if (starIndex >= 0) {
          if (target.elements.some((e, i) => e.type === 'Starred' && i !== starIndex)) {
            throw new SyntaxError('multiple starred expressions in assignment', target.line, target.column);
          }
          this.emit(Op.UNPACK_EX, starIndex | ((target.elements.length - starIndex - 1) << 8));
        } else {
          this.emit(Op.UNPACK_SEQUENCE, target.elements.length);
        }
        for (const el of target.elements) this.assign(el.type === 'Starred' ? el.value : el);
        return;
      }

      case 'Subscript':
        this.expression(target.object);
        this.expression(target.index);
        this.at(target);
        this.emit(Op.STORE_SUBSCR);
        return;

      case 'Slice':
        this.expression(target.object);
        this.sliceObject(target);
        this.at(target);
        this.emit(Op.STORE_SUBSCR);
        return;

      case 'Attribute':
        this.expression(target.object);
        this.at(target);
        this.emit(Op.STORE_ATTR, this.name(target.attr));
        return;

      case 'Starred':
        throw new SyntaxError('starred assignment target must be in a list or tuple', target.line, target.column);

      default:
        throw new SyntaxError(`cannot assign to ${describe(target)}`, target.line, target.column);
    }
  }

  private augmentedAssignment(target: Expression, op: string, value: Expression): void {
    const binop = BINARY_OPS[op];
    switch (target.type) {
      case 'Identifier':
        this.load(target.name);
        this.expression(value);
        this.at(target);
        this.emit(Op.INPLACE, binop);
        this.store(target.name);
        return;

      case 'Subscript':
      case 'Slice':
        this.expression(target.object);
        if (target.type === 'Subscript') this.expression(target.index);
        else this.sliceObject(target);
        this.at(target);
        this.emit(Op.DUP2);
        this.emit(Op.SUBSCR);
        this.expression(value);
        this.at(target);
        this.emit(Op.INPLACE, binop);
        this.emit(Op.ROT3);
        this.emit(Op.STORE_SUBSCR);
        return;

      case 'Attribute':
        this.expression(target.object);
        this.emit(Op.DUP);
        this.emit(Op.LOAD_ATTR, this.name(target.attr));
        this.expression(value);
        this.at(target);
        this.emit(Op.INPLACE, binop);
        this.emit(Op.ROT2);
        this.emit(Op.STORE_ATTR, this.name(target.attr));
        return;

      default:
        throw new SyntaxError(`'${describe(target)}' is an illegal expression for augmented assignment`, target.line, target.column);
    }
  }

  private deleteTarget(target: Expression): void {
    switch (target.type) {
      case 'Identifier':
        this.at(target);
        this.delete(target.name);
        return;
      case 'Subscript':
        this.expression(target.object);
        this.expression(target.index);
        this.at(target);
        this.emit(Op.DELETE_SUBSCR);
        return;
      case 'Slice':
        this.expression(target.object);
        this.sliceObject(target);
        this.at(target);
        this.emit(Op.DELETE_SUBSCR);
        return;
      case 'Tuple':
      case 'List':
        for (const el of target.elements) this.deleteTarget(el);
        return;
      default:
        throw new SyntaxError(`cannot delete ${describe(target)}`, target.line, target.column);
    }
  }

  // ── Expressions ───────────────────────────────────────────────────────────

  /** Jumps to `ifFalse` when `test` is falsy; falls through otherwise. */
  private condition(test: Expression, ifFalse: Label): void {
    if (test.type === 'Boolean' && test.value) return;
    this.expression(test);
    this.jump(Op.POP_JUMP_IF_FALSE, ifFalse);
  }

  private sliceObject(node: { lower: Expression | null; upper: Expression | null; step: Expression | null }): void {
    for (const bound of [node.lower, node.upper]) {
      if (bound) this.expression(bound);
      else this.loadConst(null);
    }
    if (node.step) this.expression(node.step);
    this.emit(Op.BUILD_SLICE, node.step ? 3 : 2);
  }

  /** Pushes `elements` as one list, spreading any `*starred` entries. */
  private spreadList(elements: Expression[]): void {
    this.emit(Op.BUILD_LIST, 0);
    for (const el of elements) {
      if (el.type === 'Starred') {
        this.expression(el.value);
        this.at(el);
        this.emit(Op.LIST_EXTEND);
      } else {
        this.expression(el);
        this.emit(Op.LIST_APPEND, 1);
      }
    }
  }

  private expression(e: Expression): void {
    switch (e.type) {
      case 'Number':
        this.loadConst(e.isFloat ? new PyFloat(e.value as number) : e.value);
        return;
      case 'String':
        this.loadConst(e.value);
        return;
      case 'Boolean':
        this.loadConst(e.value);
        return;
      case 'None':
        this.loadConst(null);
        return;
      case 'Ellipsis':
        this.loadConst(ELLIPSIS);
        return;

      case 'Identifier':
        this.at(e);
        this.load(e.name);
        return;

      case 'BinaryOp':
        this.expression(e.left);
        this.expression(e.right);
        this.at(e);
        this.emit(Op.BINARY, BINARY_OPS[e.op]);
        return;

      case 'UnaryOp':
        this.expression(e.operand);
        this.at(e);
        this.emit(Op.UNARY, e.op === '-' ? UnOp.NEG : e.op === '+' ? UnOp.POS : e.op === 'not' ? UnOp.NOT : UnOp.INVERT);
        return;

      case 'BooleanOp': {
        const end = this.label();
        this.expression(e.left);
        this.jump(e.op === 'and' ? Op.JUMP_IF_FALSE_OR_POP : Op.JUMP_IF_TRUE_OR_POP, end);
        this.expression(e.right);
        this.place(end);
        return;
      }

      case 'Compare': {
        this.expression(e.left);
        if (e.ops.length === 1) {
          this.expression(e.comparators[0]);
          this.at(e);
          this.emit(Op.COMPARE, COMPARE_OPS[e.ops[0]]);
          return;
        }
        // a < b < c: evaluate b once, stop at the first false link.
        const cleanup = this.label();
        const end = this.label();
        for (let i = 0; i < e.ops.length - 1; i++) {
          this.expression(e.comparators[i]);
          this.at(e);
          this.emit(Op.DUP);
          this.emit(Op.ROT3);
          this.emit(Op.COMPARE, COMPARE_OPS[e.ops[i]]);
          this.jump(Op.JUMP_IF_FALSE_OR_POP, cleanup);
        }
        this.expression(e.comparators[e.ops.length - 1]);
        this.at(e);
        this.emit(Op.COMPARE, COMPARE_OPS[e.ops[e.ops.length - 1]]);
        this.jump(Op.JUMP, end);
        this.place(cleanup);
        this.emit(Op.ROT2);
        this.emit(Op.POP);
        this.place(end);
        return;
      }

      case 'Call':
        this.call(e);
        return;

      case 'Subscript':
        this.expression(e.object);
        this.expression(e.index);
        this.at(e);
        this.emit(Op.SUBSCR);
        return;

      case 'Slice':
        this.expression(e.object);
        this.sliceObject(e);
        this.at(e);
        this.emit(Op.SUBSCR);
        return;

      case 'Attribute':
        this.expression(e.object);
        this.at(e);
        this.emit(Op.LOAD_ATTR, this.name(e.attr));
        return;

      case 'List':
      case 'Tuple':
      case 'Set': {
        const spread = e.elements.some((el) => el.type === 'Starred');
        if (spread) {
          this.spreadList(e.elements);
          this.at(e);
          if (e.type === 'Tuple') this.emit(Op.LIST_TO_TUPLE);
          else if (e.type === 'Set') this.emit(Op.LIST_TO_SET);
          return;
        }
        for (const el of e.elements) this.expression(el);
        this.at(e);
        this.emit(e.type === 'List' ? Op.BUILD_LIST : e.type === 'Tuple' ? Op.BUILD_TUPLE : Op.BUILD_SET, e.elements.length);
        return;
      }

      case 'Dict':
        this.emit(Op.BUILD_MAP);
        e.keys.forEach((key, i) => {
          if (key === null) {
            this.expression(e.values[i]);
            this.at(e);
            this.emit(Op.DICT_MERGE, 0);
          } else {
            this.expression(key);
            this.expression(e.values[i]);
            this.at(e);
            this.emit(Op.MAP_ADD, 1);
          }
        });
        return;

      case 'ListComp':
      case 'SetComp':
      case 'GeneratorExp':
        this.comprehension(e, e.generators, e.type === 'ListComp' ? '<listcomp>' : e.type === 'SetComp' ? '<setcomp>' : '<genexpr>');
        return;

      case 'DictComp':
        this.comprehension(e, e.generators, '<dictcomp>');
        return;

      case 'Ternary': {
        const otherwise = this.label();
        const end = this.label();
        this.expression(e.test);
        this.jump(Op.POP_JUMP_IF_FALSE, otherwise);
        this.expression(e.consequent);
        this.jump(Op.JUMP, end);
        this.place(otherwise);
        this.expression(e.alternate);
        this.place(end);
        return;
      }

      case 'Lambda':
        this.makeFunction(e, '<lambda>');
        return;

      case 'FString':
        this.fstring(e.parts);
        return;

      case 'NamedExpr':
        this.expression(e.value);
        this.emit(Op.DUP);
        this.at(e);
        this.store(e.target);
        return;

      case 'Starred':
        throw new SyntaxError("can't use starred expression here", e.line, e.column);

      case 'Yield':
        if (e.value) this.expression(e.value);
        else this.loadConst(null);
        this.at(e);
        this.emit(Op.YIELD);
        return;

      case 'YieldFrom': {
        // for x in iterable: yield x — then the sub-generator's return value.
        const top = this.label();
        const done = this.label();
        this.expression(e.value);
        this.at(e);
        this.emit(Op.GET_ITER);
        this.emit(Op.DUP);
        this.place(top);
        this.jump(Op.FOR_ITER, done);
        this.emit(Op.YIELD);
        this.emit(Op.POP);
        this.jump(Op.JUMP, top);
        this.place(done);
        this.emit(Op.YIELD_FROM_RESULT);
        return;
      }
    }
  }

  private fstring(parts: FStringPart[]): void {
    let count = 0;
    for (const part of parts) {
      if (part.text) {
        this.loadConst(part.text);
        count++;
      }
      if (!part.expr) continue;
      this.expression(part.expr);
      let flags = part.conversion === 's' ? 1 : part.conversion === 'r' ? 2 : part.conversion === 'a' ? 3 : 0;
      if (part.specParts) {
        this.fstring(part.specParts);
        flags |= 4;
      } else if (part.formatSpec) {
        this.loadConst(part.formatSpec);
        flags |= 4;
      }
      this.at(part.expr);
      this.emit(Op.FORMAT_VALUE, flags);
      count++;
    }
    if (count === 0) this.loadConst('');
    else if (count > 1) this.emit(Op.BUILD_STRING, count);
  }

  private call(e: Expression & { type: 'Call' }): void {
    const seen = new Set<string>();
    for (const kw of e.kwargs) {
      if (seen.has(kw.name)) throw new SyntaxError(`keyword argument repeated: ${kw.name}`, e.line, e.column);
      seen.add(kw.name);
    }
    const spread = e.args.some((a) => a.type === 'Starred') || e.doubleStarArgs !== undefined;

    if (!spread && e.func.type === 'Attribute' && e.args.length + e.kwargs.length <= 255) {
      // obj.method(args): dispatch on the receiver without building a bound method.
      this.expression(e.func.object);
      for (const arg of e.args) this.expression(arg);
      for (const kw of e.kwargs) this.expression(kw.value);
      this.at(e);
      if (e.kwargs.length > 0) this.emit(Op.KW_NAMES, this.constant(e.kwargs.map((kw) => kw.name)));
      this.emit(Op.CALL_METHOD, (this.name(e.func.attr) << 8) | (e.args.length + e.kwargs.length));
      return;
    }

    this.expression(e.func);
    if (!spread) {
      for (const arg of e.args) this.expression(arg);
      for (const kw of e.kwargs) this.expression(kw.value);
      this.at(e);
      if (e.kwargs.length > 0) this.emit(Op.KW_NAMES, this.constant(e.kwargs.map((kw) => kw.name)));
      this.emit(Op.CALL, e.args.length + e.kwargs.length);
      return;
    }

    // f(*args, **kwargs): build one argument list and one keyword dict.
    this.at(e);
    this.spreadList(e.args);
    const hasKeywords = e.kwargs.length > 0 || e.doubleStarArgs !== undefined;
    if (hasKeywords) {
      this.emit(Op.BUILD_MAP);
      for (const kw of e.kwargs) {
        this.loadConst(kw.name);
        this.expression(kw.value);
        this.emit(Op.MAP_ADD, 1);
      }
      for (const mapping of e.doubleStarArgs ?? []) {
        this.expression(mapping);
        this.at(e);
        this.emit(Op.DICT_MERGE, 1);
      }
    }
    this.at(e);
    this.emit(Op.CALL_EX, hasKeywords ? 1 : 0);
  }

  /**
   * A comprehension runs as its own function so its loop variables stay
   * private. The first iterable is evaluated here and passed as the argument.
   */
  private comprehension(node: Expression, generators: Comprehension[], name: string): void {
    const scope = this.scopes.get(node)!;
    const gen = new CodeGen(scope, this.scopes, this.globals, name, null);
    gen.at(node);
    gen.setUpCells();
    gen.local('.0');
    gen.code.argCount = 1;
    gen.comprehensionBody(node, generators);

    this.at(node);
    this.emitMakeFunction(gen, 0, []);
    this.expression(generators[0].iter);
    this.at(node);
    this.emit(Op.GET_ITER);
    this.emit(Op.CALL, 1);
  }

  private comprehensionBody(node: Expression, generators: Comprehension[]): void {
    const isGenerator = node.type === 'GeneratorExp';
    if (node.type === 'ListComp') this.emit(Op.BUILD_LIST, 0);
    else if (node.type === 'SetComp') this.emit(Op.BUILD_SET, 0);
    else if (node.type === 'DictComp') this.emit(Op.BUILD_MAP);

    const tops: Label[] = [];
    const ends: Label[] = [];
    generators.forEach((generator, i) => {
      if (i === 0) {
        this.emit(Op.LOAD_FAST, 0);
      } else {
        this.expression(generator.iter);
        this.emit(Op.GET_ITER);
      }
      const top = this.label();
      const end = this.label();
      tops.push(top);
      ends.push(end);
      this.place(top);
      this.jump(Op.FOR_ITER, end);
      this.assign(generator.target);
      for (const cond of generator.conditions) {
        this.expression(cond);
        this.jump(Op.POP_JUMP_IF_FALSE, top);
      }
    });

    // The accumulator sits below one iterator per `for` clause.
    const depth = generators.length + 1;
    this.at(node);
    if (node.type === 'DictComp') {
      this.expression(node.key);
      this.expression(node.value);
      this.emit(Op.MAP_ADD, depth);
    } else {
      const element = (node as Expression & { element: Expression }).element;
      this.expression(element);
      if (isGenerator) {
        this.emit(Op.YIELD);
        this.emit(Op.POP);
      } else {
        this.emit(node.type === 'ListComp' ? Op.LIST_APPEND : Op.SET_ADD, depth);
      }
    }

    for (let i = generators.length - 1; i >= 0; i--) {
      this.jump(Op.JUMP, tops[i]);
      this.place(ends[i]);
    }
    if (isGenerator) this.loadConst(null);
    this.emit(Op.RETURN);
  }
}

function describe(e: Expression): string {
  switch (e.type) {
    case 'Number': case 'String': case 'Boolean': case 'None': case 'FString': return 'literal';
    case 'Call': return 'function call';
    case 'BinaryOp': case 'UnaryOp': case 'BooleanOp': return 'expression';
    case 'Compare': return 'comparison';
    case 'Lambda': return 'lambda';
    default: return 'expression';
  }
}

/** Statements whose value becomes the result of `run()`: the last top-level
 *  statement, and the last statement of each of its branches. */
function resultStatements(program: Program): Set<Statement> {
  const out = new Set<Statement>();
  const mark = (stmts: Statement[]) => {
    const last = stmts[stmts.length - 1];
    if (!last) return;
    out.add(last);
    switch (last.type) {
      case 'If': case 'For': case 'While':
        mark(last.body);
        mark(last.orelse);
        break;
      case 'Try':
        mark(last.body);
        for (const handler of last.handlers) mark(handler.body);
        mark(last.orelse);
        break;
    }
  };
  mark(program);
  return out;
}

/** Compiles a program for the interpreter that owns `globals`. The code
 *  refers to top-level variables by slot, so it only runs correctly there. */
export function compile(program: Program, globals: Globals): Code {
  const analyzer = new Analyzer();
  analyzer.analyze(program);
  const scope = analyzer.scopes.get(program)!;
  return new CodeGen(scope, analyzer.scopes, globals, '<module>', resultStatements(program)).module(program);
}
