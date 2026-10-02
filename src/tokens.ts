/**
 * Token types for the Python lexer
 */
export enum TokenType {
  // Literals
  NUMBER = 'NUMBER',
  STRING = 'STRING',
  FSTRING = 'FSTRING',  // f-string like f"hello {name}"
  TRUE = 'TRUE',
  FALSE = 'FALSE',
  NONE = 'NONE',

  // Identifiers
  IDENTIFIER = 'IDENTIFIER',

  // Keywords
  IF = 'IF',
  ELIF = 'ELIF',
  ELSE = 'ELSE',
  FOR = 'FOR',
  WHILE = 'WHILE',
  IN = 'IN',
  NOT = 'NOT',
  IS = 'IS',
  AND = 'AND',
  OR = 'OR',
  DEF = 'DEF',
  RETURN = 'RETURN',
  BREAK = 'BREAK',
  CONTINUE = 'CONTINUE',
  PASS = 'PASS',
  LAMBDA = 'LAMBDA',
  TRY = 'TRY',
  EXCEPT = 'EXCEPT',
  AS = 'AS',
  FINALLY = 'FINALLY',
  RAISE = 'RAISE',
  GLOBAL = 'GLOBAL',
  NONLOCAL = 'NONLOCAL',
  DEL = 'DEL',
  ASSERT = 'ASSERT',
  IMPORT = 'IMPORT',
  FROM = 'FROM',
  YIELD = 'YIELD',

  // Operators
  PLUS = 'PLUS',           // +
  MINUS = 'MINUS',         // -
  STAR = 'STAR',           // *
  SLASH = 'SLASH',         // /
  PERCENT = 'PERCENT',     // %
  DOUBLE_SLASH = 'DOUBLE_SLASH',   // //
  DOUBLE_STAR = 'DOUBLE_STAR',     // **

  // Bitwise
  AMPERSAND = 'AMPERSAND',       // &
  PIPE = 'PIPE',                 // |
  CARET = 'CARET',               // ^
  TILDE = 'TILDE',               // ~
  LSHIFT = 'LSHIFT',             // <<
  RSHIFT = 'RSHIFT',             // >>

  // Comparison
  EQ = 'EQ',               // ==
  NE = 'NE',               // !=
  LT = 'LT',               // <
  GT = 'GT',               // >
  LE = 'LE',               // <=
  GE = 'GE',               // >=

  // Assignment
  ASSIGN = 'ASSIGN',       // =
  WALRUS = 'WALRUS',       // :=
  PLUS_ASSIGN = 'PLUS_ASSIGN',     // +=
  MINUS_ASSIGN = 'MINUS_ASSIGN',   // -=
  STAR_ASSIGN = 'STAR_ASSIGN',     // *=
  SLASH_ASSIGN = 'SLASH_ASSIGN',   // /=
  DOUBLE_SLASH_ASSIGN = 'DOUBLE_SLASH_ASSIGN', // //=
  PERCENT_ASSIGN = 'PERCENT_ASSIGN',           // %=
  DOUBLE_STAR_ASSIGN = 'DOUBLE_STAR_ASSIGN',   // **=
  AMPERSAND_ASSIGN = 'AMPERSAND_ASSIGN',       // &=
  PIPE_ASSIGN = 'PIPE_ASSIGN',                 // |=
  CARET_ASSIGN = 'CARET_ASSIGN',               // ^=
  LSHIFT_ASSIGN = 'LSHIFT_ASSIGN',             // <<=
  RSHIFT_ASSIGN = 'RSHIFT_ASSIGN',             // >>=

  // Delimiters
  LPAREN = 'LPAREN',       // (
  RPAREN = 'RPAREN',       // )
  LBRACKET = 'LBRACKET',   // [
  RBRACKET = 'RBRACKET',   // ]
  LBRACE = 'LBRACE',       // {
  RBRACE = 'RBRACE',       // }
  COMMA = 'COMMA',         // ,
  COLON = 'COLON',         // :
  DOT = 'DOT',             // .
  AT = 'AT',               // @
  ARROW = 'ARROW',         // ->
  ELLIPSIS = 'ELLIPSIS',   // ...

  // Whitespace (Python-specific)
  NEWLINE = 'NEWLINE',
  INDENT = 'INDENT',
  DEDENT = 'DEDENT',

  // Special
  EOF = 'EOF',
}

export interface FStringTokenPart {
  text: string;
  expr: string | null;
  formatSpec?: string;
  /** `!r`, `!s` or `!a` conversion, without the `!`. */
  conversion?: string;
}

export interface Token {
  type: TokenType;
  value: string | number | bigint | null;
  line: number;
  column: number;
  /** NUMBER tokens: true for a float literal (`1.0`, `1e3`), false for an int. */
  isFloat?: boolean;
  // For f-strings: array of string parts and expression strings
  fstringParts?: FStringTokenPart[];
}

export const KEYWORDS: Record<string, TokenType> = {
  'if': TokenType.IF,
  'elif': TokenType.ELIF,
  'else': TokenType.ELSE,
  'for': TokenType.FOR,
  'while': TokenType.WHILE,
  'in': TokenType.IN,
  'not': TokenType.NOT,
  'is': TokenType.IS,
  'and': TokenType.AND,
  'or': TokenType.OR,
  'def': TokenType.DEF,
  'return': TokenType.RETURN,
  'break': TokenType.BREAK,
  'continue': TokenType.CONTINUE,
  'pass': TokenType.PASS,
  'lambda': TokenType.LAMBDA,
  'try': TokenType.TRY,
  'except': TokenType.EXCEPT,
  'as': TokenType.AS,
  'finally': TokenType.FINALLY,
  'raise': TokenType.RAISE,
  'global': TokenType.GLOBAL,
  'nonlocal': TokenType.NONLOCAL,
  'del': TokenType.DEL,
  'assert': TokenType.ASSERT,
  'import': TokenType.IMPORT,
  'from': TokenType.FROM,
  'yield': TokenType.YIELD,
  'True': TokenType.TRUE,
  'False': TokenType.FALSE,
  'None': TokenType.NONE,
};

