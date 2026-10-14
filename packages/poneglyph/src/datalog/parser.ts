import { parseUri } from "../domain/identifiers.js";
import { parsed, rejected, type ParseError, type ParseResult } from "../domain/result.js";
import { createDatalogQuery, type BuiltinClause, type BuiltinName, type DatalogQuery, type FactClause, type Term } from "./ast.js";
import { integerValue, stringValue } from "./value.js";

const MAX_QUERY_LENGTH = 8_192;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const BUILTINS = new Set<BuiltinName>([
  "=", "<", "<=", ">", ">=", "eq", "lt", "lte", "gt", "gte",
  "before", "after", "contains", "startsWith", "endsWith",
]);

type Token =
  | Readonly<{ kind: "identifier" | "quoted_identifier"; value: string; offset: number }>
  | Readonly<{ kind: "string"; value: string; offset: number }>
  | Readonly<{ kind: "integer"; value: bigint; offset: number }>
  | Readonly<{ kind: "punctuation"; value: "(" | ")" | "," | "!"; offset: number }>
  | Readonly<{ kind: "operator"; value: "=" | ">" | ">=" | "<" | "<="; offset: number }>;

export function parseDatalogQuery(source: string): ParseResult<DatalogQuery> {
  if (source.length > MAX_QUERY_LENGTH) {
    return rejected("query", `query text cannot exceed ${MAX_QUERY_LENGTH} characters`);
  }
  const tokens = tokenize(source);
  if (!tokens.ok) return tokens;
  if (tokens.value.length === 0) return rejected("query", "expected a query");

  const parser = new Parser(source, tokens.value);
  return parser.parse();
}

function tokenize(source: string): ParseResult<readonly Token[]> {
  const tokens: Token[] = [];
  let offset = 0;

  while (offset < source.length) {
    const character = source[offset];
    if (character === undefined) break;
    if (/\s/.test(character)) {
      offset += 1;
      continue;
    }

    if (character === '"') {
      const string = readJsonString(source, offset);
      if (!string.ok) return string;
      tokens.push(string.value.token);
      offset = string.value.nextOffset;
      continue;
    }
    if (character === "'") {
      const quoted = readQuotedIdentifier(source, offset);
      if (!quoted.ok) return quoted;
      tokens.push(quoted.value.token);
      offset = quoted.value.nextOffset;
      continue;
    }
    if (isIdentifierStart(character) || character === "_") {
      const start = offset;
      offset += 1;
      while (offset < source.length && isIdentifierContinuation(source[offset] ?? "")) {
        offset += 1;
      }
      tokens.push({ kind: "identifier", value: source.slice(start, offset), offset: start });
      continue;
    }
    if (isDigit(character) || (character === "-" && isDigit(source[offset + 1] ?? ""))) {
      const start = offset;
      offset += character === "-" ? 1 : 0;
      while (isDigit(source[offset] ?? "")) offset += 1;
      const text = source.slice(start, offset);
      const value = BigInt(text);
      if (value < I64_MIN || value > I64_MAX) {
        return rejected("query", "integer literal is outside the signed 64-bit range", start);
      }
      tokens.push({ kind: "integer", value, offset: start });
      continue;
    }

    if (character === ">" || character === "<") {
      const next = source[offset + 1];
      const value = next === "=" ? `${character}=` : character;
      tokens.push({ kind: "operator", value: value as ">" | ">=" | "<" | "<=", offset });
      offset += value.length;
      continue;
    }
    if (character === "=") {
      tokens.push({ kind: "operator", value: "=", offset });
      offset += 1;
      continue;
    }
    if (character === "(" || character === ")" || character === "," || character === "!") {
      tokens.push({ kind: "punctuation", value: character, offset });
      offset += 1;
      continue;
    }

    return rejected("query", `unexpected character ${JSON.stringify(character)}`, offset);
  }

  return parsed(Object.freeze(tokens));
}

function readJsonString(
  source: string,
  start: number,
): ParseResult<Readonly<{ token: Token; nextOffset: number }>> {
  let escaped = false;
  for (let offset = start + 1; offset < source.length; offset += 1) {
    const character = source[offset];
    if (character === undefined) break;
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      const raw = source.slice(start, offset + 1);
      try {
        const value: unknown = JSON.parse(raw);
        if (typeof value !== "string") return rejected("query", "expected a string literal", start);
        return parsed({ token: { kind: "string", value, offset: start }, nextOffset: offset + 1 });
      } catch {
        return rejected("query", "invalid JSON string literal", start);
      }
    }
  }
  return rejected("query", "unterminated string literal", start);
}

function readQuotedIdentifier(
  source: string,
  start: number,
): ParseResult<Readonly<{ token: Token; nextOffset: number }>> {
  const end = source.indexOf("'", start + 1);
  if (end < 0) return rejected("query", "unterminated quoted identifier", start);
  const value = source.slice(start + 1, end);
  if (value.length === 0) return rejected("query", "quoted identifier cannot be empty", start);
  return parsed({ token: { kind: "quoted_identifier", value, offset: start }, nextOffset: end + 1 });
}

function isIdentifierStart(character: string): boolean {
  return /^[A-Za-z]$/.test(character);
}

function isIdentifierContinuation(character: string): boolean {
  return /^[A-Za-z0-9:_?+.-]$/.test(character);
}

function isDigit(character: string): boolean {
  return /^[0-9]$/.test(character);
}

class Parser {
  private cursor = 0;

  constructor(
    private readonly source: string,
    private readonly tokens: readonly Token[],
  ) {}

  parse(): ParseResult<DatalogQuery> {
    const facts: FactClause[] = [];
    const constraints: BuiltinClause[] = [];

    while (this.cursor < this.tokens.length) {
      const clause = this.parseClause();
      if (!clause.ok) return clause;
      if (clause.value.kind === "fact") facts.push(clause.value);
      else constraints.push(clause.value);

      if (this.cursor === this.tokens.length) break;
      const comma = this.consumePunctuation(",");
      if (!comma) {
        const token = this.peek();
        return this.errorAt(token, "expected a comma between clauses");
      }
      if (this.cursor === this.tokens.length) {
        return rejected("query", "expected a clause after the comma", this.source.length);
      }
    }

    return createDatalogQuery(facts, constraints);
  }

  private parseClause(): ParseResult<FactClause | BuiltinClause> {
    if (this.peek()?.kind === "punctuation" && this.peek()?.value === "!") {
      return this.errorAt(this.take(), "negated relations are outside the initial Datalog subset");
    }

    if (this.isCallStart()) return this.parseCallClause();
    return this.parseComparison();
  }

  private parseCallClause(): ParseResult<FactClause | BuiltinClause> {
    const predicate = this.take();
    if (predicate === undefined || (predicate.kind !== "identifier" && predicate.kind !== "quoted_identifier")) {
      return this.errorAt(predicate, "expected a relation name");
    }
    if (!this.consumePunctuation("(")) return this.errorAt(this.peek(), "expected `(` after relation name");

    const left = this.parseTerm();
    if (!left.ok) return left;
    if (!this.consumePunctuation(",")) return this.errorAt(this.peek(), "expected `,` between relation terms");
    const right = this.parseTerm();
    if (!right.ok) return right;
    if (!this.consumePunctuation(")")) {
      return this.errorAt(this.peek(), "relations in this subset must have exactly two terms");
    }

    if (BUILTINS.has(predicate.value as BuiltinName)) {
      return parsed(Object.freeze({
        kind: "builtin",
        name: predicate.value as BuiltinName,
        left: left.value,
        right: right.value,
      }));
    }

    const parsedPredicate = parseUri(predicate.value, "query.predicate");
    if (!parsedPredicate.ok) {
      return rejected("query", parsedPredicate.error.message, predicate.offset);
    }
    return parsed(Object.freeze({
      kind: "fact",
      predicate: parsedPredicate.value,
      entity: left.value,
      value: right.value,
    }));
  }

  private parseComparison(): ParseResult<BuiltinClause> {
    const left = this.parseTerm();
    if (!left.ok) return left;
    const operator = this.take();
    if (operator?.kind !== "operator") return this.errorAt(operator, "expected a supported comparison operator");
    const right = this.parseTerm();
    if (!right.ok) return right;
    return parsed(Object.freeze({ kind: "builtin", name: operator.value, left: left.value, right: right.value }));
  }

  private parseTerm(): ParseResult<Term> {
    const token = this.take();
    if (token === undefined) return this.errorAt(undefined, "expected a term");

    if (token.kind === "integer") {
      return parsed(Object.freeze({ kind: "constant", value: integerValue(token.value) }));
    }
    if (token.kind === "string" || token.kind === "quoted_identifier") {
      return parsed(Object.freeze({ kind: "constant", value: stringValue(token.value) }));
    }
    if (token.kind === "identifier") {
      if (token.value === "_") return parsed(Object.freeze({ kind: "wildcard" }));
      const firstCharacter = token.value[0] ?? "";
      if (/^[A-Z]$/.test(firstCharacter)) {
        return parsed(Object.freeze({ kind: "variable", name: token.value }));
      }
      return parsed(Object.freeze({ kind: "constant", value: stringValue(token.value) }));
    }
    return this.errorAt(token, "expected a variable, constant, or wildcard");
  }

  private isCallStart(): boolean {
    const current = this.peek();
    const next = this.tokens[this.cursor + 1];
    return (current?.kind === "identifier" || current?.kind === "quoted_identifier") &&
      next?.kind === "punctuation" && next.value === "(";
  }

  private consumePunctuation(value: "(" | ")" | "," | "!"): boolean {
    const token = this.peek();
    if (token?.kind !== "punctuation" || token.value !== value) return false;
    this.cursor += 1;
    return true;
  }

  private errorAt<T>(token: Token | undefined, message: string): ParseResult<T> {
    const offset = token?.offset ?? this.source.length;
    return rejected("query", message, offset);
  }

  private peek(): Token | undefined {
    return this.tokens[this.cursor];
  }

  private take(): Token | undefined {
    const token = this.tokens[this.cursor];
    if (token !== undefined) this.cursor += 1;
    return token;
  }
}
