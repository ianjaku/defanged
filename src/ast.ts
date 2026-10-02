/**
 * Abstract Syntax Tree node types for Python
 */

// Base interface for all AST nodes with location info
export interface ASTNode {
  line: number;
  column: number;
}

// ============ Expressions ============

export interface NumberLiteral extends ASTNode {
  type: 'Number';
  /** bigint for int literals beyond the safe-integer range. */
  value: number | bigint;
  /** True for float literals (`1.0`, `1e3`); `1` and `1.0` are different values. */
  isFloat: boolean;
}

export interface EllipsisLiteral extends ASTNode {
  type: 'Ellipsis';
}

export interface StringLiteral extends ASTNode {
  type: 'String';
  value: string;
}

export interface BooleanLiteral extends ASTNode {
  type: 'Boolean';
  value: boolean;
}

export interface NoneLiteral extends ASTNode {
  type: 'None';
}

export interface Identifier extends ASTNode {
  type: 'Identifier';
  name: string;
}

export interface BinaryOp extends ASTNode {
  type: 'BinaryOp';
  op: '+' | '-' | '*' | '/' | '//' | '%' | '**' | '&' | '|' | '^' | '<<' | '>>';
  left: Expression;
  right: Expression;
}

export interface UnaryOp extends ASTNode {
  type: 'UnaryOp';
  op: '-' | '+' | 'not' | '~';
  operand: Expression;
}

export interface BooleanOp extends ASTNode {
  type: 'BooleanOp';
  op: 'and' | 'or';
  left: Expression;
  right: Expression;
}

export interface Compare extends ASTNode {
  type: 'Compare';
  left: Expression;
  ops: ('==' | '!=' | '<' | '>' | '<=' | '>=' | 'in' | 'not in' | 'is' | 'is not')[];
  comparators: Expression[];
}

export interface Call extends ASTNode {
  type: 'Call';
  func: Expression;
  /** Positional arguments in source order; `*xs` appears as a Starred node. */
  args: Expression[];
  kwargs: { name: string; value: Expression }[];
  doubleStarArgs?: Expression[];
}

export interface Subscript extends ASTNode {
  type: 'Subscript';
  object: Expression;
  index: Expression;
}

export interface Slice extends ASTNode {
  type: 'Slice';
  object: Expression;
  lower: Expression | null;
  upper: Expression | null;
  step: Expression | null;
}

export interface Attribute extends ASTNode {
  type: 'Attribute';
  object: Expression;
  attr: string;
}

export interface List extends ASTNode {
  type: 'List';
  elements: Expression[];
}

export interface Dict extends ASTNode {
  type: 'Dict';
  /** A null key marks a `**mapping` entry whose value is the mapping. */
  keys: (Expression | null)[];
  values: Expression[];
}

export interface Tuple extends ASTNode {
  type: 'Tuple';
  elements: Expression[];
}

export interface SetLiteral extends ASTNode {
  type: 'Set';
  elements: Expression[];
}

export interface ListComp extends ASTNode {
  type: 'ListComp';
  element: Expression;
  generators: Comprehension[];
}

export interface DictComp extends ASTNode {
  type: 'DictComp';
  key: Expression;
  value: Expression;
  generators: Comprehension[];
}

export interface SetComp extends ASTNode {
  type: 'SetComp';
  element: Expression;
  generators: Comprehension[];
}

export interface GeneratorExp extends ASTNode {
  type: 'GeneratorExp';
  element: Expression;
  generators: Comprehension[];
}

export interface Comprehension {
  target: Expression;
  iter: Expression;
  conditions: Expression[];
}

export interface Ternary extends ASTNode {
  type: 'Ternary';
  test: Expression;
  consequent: Expression;
  alternate: Expression;
}

export interface Lambda extends ASTNode, Signature {
  type: 'Lambda';
  body: Expression;
}

export interface FStringPart {
  text: string;
  expr: Expression | null;
  /** `!r` / `!s` / `!a`. */
  conversion?: 'r' | 's' | 'a';
  formatSpec?: string;
  /** Set instead of formatSpec when the spec itself interpolates (`{x:{width}}`). */
  specParts?: FStringPart[];
}

export interface FString extends ASTNode {
  type: 'FString';
  parts: FStringPart[];
}

export interface NamedExpr extends ASTNode {
  type: 'NamedExpr';
  target: string;  // Variable name to assign to
  value: Expression;
}

export interface Starred extends ASTNode {
  type: 'Starred';
  value: Expression;
}

export interface Yield extends ASTNode {
  type: 'Yield';
  value: Expression | null;
}

export interface YieldFrom extends ASTNode {
  type: 'YieldFrom';
  value: Expression;
}

export type Expression =
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral
  | NoneLiteral
  | EllipsisLiteral
  | Identifier
  | BinaryOp
  | UnaryOp
  | BooleanOp
  | Compare
  | Call
  | Subscript
  | Slice
  | Attribute
  | List
  | Dict
  | Tuple
  | SetLiteral
  | ListComp
  | DictComp
  | SetComp
  | GeneratorExp
  | Ternary
  | Lambda
  | FString
  | NamedExpr
  | Starred
  | Yield
  | YieldFrom;

// ============ Statements ============

export interface ExpressionStmt extends ASTNode {
  type: 'ExpressionStmt';
  expression: Expression;
}

export interface Assignment extends ASTNode {
  type: 'Assignment';
  targets: Expression[];
  value: Expression;
}

export interface AugmentedAssignment extends ASTNode {
  type: 'AugmentedAssignment';
  target: Expression;
  op: '+=' | '-=' | '*=' | '/=' | '//=' | '%=' | '**=' | '&=' | '|=' | '^=' | '<<=' | '>>=';
  value: Expression;
}

export interface If extends ASTNode {
  type: 'If';
  test: Expression;
  body: Statement[];
  orelse: Statement[];
}

export interface For extends ASTNode {
  type: 'For';
  target: Expression;
  iter: Expression;
  body: Statement[];
  orelse: Statement[];
}

export interface While extends ASTNode {
  type: 'While';
  test: Expression;
  body: Statement[];
  orelse: Statement[];
}

/** Parameter list shared by `def` and `lambda`. */
export interface Signature {
  params: Parameter[];
  restParam?: string;
  /** Parameters after `*` or `*args`: passable by keyword only. */
  kwOnlyParams: Parameter[];
  kwargsParam?: string;
}

export interface FunctionDef extends ASTNode, Signature {
  type: 'FunctionDef';
  name: string;
  decorators: Expression[];
  body: Statement[];
}

export interface Parameter {
  name: string;
  default?: Expression;
}

export interface Raise extends ASTNode {
  type: 'Raise';
  value: Expression | null;
  /** `raise X from cause`; evaluated but otherwise ignored. */
  cause?: Expression | null;
}

export interface Global extends ASTNode {
  type: 'Global';
  names: string[];
}

export interface Nonlocal extends ASTNode {
  type: 'Nonlocal';
  names: string[];
}

export interface Del extends ASTNode {
  type: 'Del';
  targets: Expression[];
}

export interface Assert extends ASTNode {
  type: 'Assert';
  test: Expression;
  msg: Expression | null;
}

export interface Return extends ASTNode {
  type: 'Return';
  value: Expression | null;
}

export interface Break extends ASTNode {
  type: 'Break';
}

export interface Continue extends ASTNode {
  type: 'Continue';
}

export interface Pass extends ASTNode {
  type: 'Pass';
}

export interface ExceptHandler extends ASTNode {
  type: 'ExceptHandler';
  exceptionTypes: string[] | null;  // Exception type names (e.g., ['ValueError', 're.error']) or null for bare except
  name: string | null;           // Variable name to bind exception to (e.g., 'e' in 'except ValueError as e')
  body: Statement[];
}

export interface Try extends ASTNode {
  type: 'Try';
  body: Statement[];
  handlers: ExceptHandler[];
  orelse: Statement[];     // else block (runs if no exception)
  finalbody: Statement[];  // finally block
}

export interface Import extends ASTNode {
  type: 'Import';
  modules: Array<{ name: string; alias?: string }>;
}

export interface ImportFrom extends ASTNode {
  type: 'ImportFrom';
  module: string;
  names: Array<{ name: string; alias?: string }> | '*';
}

export type Statement =
  | ExpressionStmt
  | Assignment
  | AugmentedAssignment
  | If
  | For
  | While
  | FunctionDef
  | Return
  | Break
  | Continue
  | Pass
  | Try
  | Raise
  | Global
  | Nonlocal
  | Del
  | Assert
  | Import
  | ImportFrom;

export type Program = Statement[];
