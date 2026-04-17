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
  value: number;
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
  op: '+' | '-' | '*' | '/' | '//' | '%' | '**';
  left: Expression;
  right: Expression;
}

export interface UnaryOp extends ASTNode {
  type: 'UnaryOp';
  op: '-' | '+' | 'not';
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
  args: Expression[];
  kwargs: { name: string; value: Expression }[];
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
  keys: Expression[];
  values: Expression[];
}

export interface Tuple extends ASTNode {
  type: 'Tuple';
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

export interface Lambda extends ASTNode {
  type: 'Lambda';
  params: string[];
  body: Expression;
}

export interface FStringPart {
  text: string;
  expr: Expression | null;
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

export type Expression =
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral
  | NoneLiteral
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
  | ListComp
  | DictComp
  | GeneratorExp
  | Ternary
  | Lambda
  | FString
  | NamedExpr;

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
  op: '+=' | '-=' | '*=' | '/=';
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
}

export interface While extends ASTNode {
  type: 'While';
  test: Expression;
  body: Statement[];
}

export interface FunctionDef extends ASTNode {
  type: 'FunctionDef';
  name: string;
  params: Parameter[];
  body: Statement[];
}

export interface Parameter {
  name: string;
  default?: Expression;
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
  exceptionTypes: string[] | null;  // Exception type names (e.g., ['ValueError', 'TypeError']) or null for bare except
  name: string | null;           // Variable name to bind exception to (e.g., 'e' in 'except ValueError as e')
  body: Statement[];
}

export interface Try extends ASTNode {
  type: 'Try';
  body: Statement[];
  handlers: ExceptHandler[];
  finalbody: Statement[];  // finally block
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
  | Try;

export type Program = Statement[];
