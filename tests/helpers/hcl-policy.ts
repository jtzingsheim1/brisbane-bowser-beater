// Minimal reader for the IAM policy documents this repo commits in two
// different notations, so a test can compare them as plain data:
//
//   * infra/*.tf          -- HCL `jsonencode({ ... })` arguments
//   * infra/BOOTSTRAP.md  -- JSON heredocs in the CloudShell bootstrap script
//
// Deliberately not a general HCL parser. It understands objects, arrays and
// string literals, and represents everything else (resource references,
// function calls, numbers, booleans) as an opaque HclExpression. That is
// enough for policy documents: every field the boundary guard compares
// (Effect, Action, Sid) is a string literal, and only Resource and Condition
// hold Terraform expressions.
//
// It throws on anything it does not understand rather than returning a
// partial result. A reader that silently yielded an empty action set would
// make every assertion in tests/infra-boundaries.test.ts pass vacuously,
// which is the one failure mode a guard like this must not have.

// IAM wildcard matching. IAM policy elements use shell-style globs: `*` for
// any sequence, `?` for one character. Used for both Action patterns
// (`iam:*` must count as granting `iam:CreateRole`) and Resource ARNs (a Deny
// on `policy/bbb-mcp-boundary-*` must count as covering a specific boundary).
export function matchesGlob(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = escaped.split("*").join("[\\s\\S]*").split("?").join("[\\s\\S]");
  return new RegExp(`^${re}$`).test(value);
}

export class HclExpression {
  constructor(readonly source: string) {}
}

export type HclValue =
  | string
  | HclExpression
  | HclValue[]
  | { [key: string]: HclValue };

const IDENT = /[A-Za-z0-9_-]/;

export class HclReader {
  private i = 0;

  constructor(
    private readonly src: string,
    start = 0,
  ) {
    this.i = start;
  }

  private fail(message: string): never {
    const line = this.src.slice(0, this.i).split("\n").length;
    const near = JSON.stringify(this.src.slice(this.i, this.i + 60));
    throw new Error(`HCL parse error at line ${line}: ${message}; near ${near}`);
  }

  private peek(): string {
    return this.src[this.i] ?? "";
  }

  // Whitespace and comments. `#` and `//` run to end of line; `/* */` is
  // block-scoped.
  skipTrivia(): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\r" || c === "\n") {
        this.i++;
      } else if (c === "#" || (c === "/" && this.src[this.i + 1] === "/")) {
        const nl = this.src.indexOf("\n", this.i);
        this.i = nl === -1 ? this.src.length : nl;
      } else if (c === "/" && this.src[this.i + 1] === "*") {
        const end = this.src.indexOf("*/", this.i + 2);
        if (end === -1) this.fail("unterminated block comment");
        this.i = end + 2;
      } else {
        return;
      }
    }
  }

  parseValue(): HclValue {
    this.skipTrivia();
    const c = this.peek();
    if (c === "{") return this.parseObject();
    if (c === "[") return this.parseArray();
    if (c === '"') return this.parseString();
    if (c === "") this.fail("unexpected end of input");
    return this.parseExpression();
  }

  parseObject(): { [key: string]: HclValue } {
    if (this.peek() !== "{") this.fail("expected {");
    this.i++;
    const out: { [key: string]: HclValue } = {};
    for (;;) {
      this.skipTrivia();
      const c = this.peek();
      if (c === "") this.fail("unterminated object");
      if (c === ",") {
        this.i++;
        continue;
      }
      if (c === "}") {
        this.i++;
        return out;
      }

      const key = c === '"' ? this.parseString() : this.parseIdent();
      this.skipTrivia();
      const sep = this.peek();
      if (sep === "=" || sep === ":") {
        this.i++;
        out[key] = this.parseValue();
      } else if (sep === "{") {
        // HCL nested block: `environment { ... }` with no `=`.
        out[key] = this.parseObject();
      } else {
        this.fail(`expected = or { after key ${JSON.stringify(key)}`);
      }
    }
  }

  parseArray(): HclValue[] {
    if (this.peek() !== "[") this.fail("expected [");
    this.i++;
    const out: HclValue[] = [];
    for (;;) {
      this.skipTrivia();
      const c = this.peek();
      if (c === "") this.fail("unterminated array");
      if (c === ",") {
        this.i++;
        continue;
      }
      if (c === "]") {
        this.i++;
        return out;
      }
      out.push(this.parseValue());
    }
  }

  // Returns the literal text. `${...}` interpolations are left verbatim in
  // the result; nothing the guard compares contains one, and callers can
  // test for the marker if they need to.
  parseString(): string {
    if (this.peek() !== '"') this.fail("expected a string");
    this.i++;
    let out = "";
    for (;;) {
      const c = this.src[this.i];
      if (c === undefined) this.fail("unterminated string");
      if (c === '"') {
        this.i++;
        return out;
      }
      if (c === "\\") {
        const esc = this.src[this.i + 1];
        if (esc === undefined) this.fail("unterminated escape");
        // Only the escapes this repo's policy documents actually use. An
        // unmodelled one (\\uXXXX, say) must fail rather than decay to its
        // literal characters: silently wrong beats nothing, but not by much,
        // and this reader's contract is understand-it-or-throw.
        const simple: Record<string, string> = {
          n: "\n",
          t: "\t",
          r: "\r",
          '"': '"',
          "\\": "\\",
          "/": "/",
        };
        const mapped = simple[esc];
        if (mapped === undefined) this.fail(`unsupported escape \\${esc}`);
        out += mapped;
        this.i += 2;
        continue;
      }
      // HCL's escaped interpolation: `$${` is a literal `${`, not a template.
      if (c === "$" && this.src[this.i + 1] === "$" && this.src[this.i + 2] === "{") {
        out += "${";
        this.i += 3;
        continue;
      }
      if (c === "$" && this.src[this.i + 1] === "{") {
        out += this.readInterpolation();
        continue;
      }
      out += c;
      this.i++;
    }
  }

  // Copies a `${ ... }` interpolation verbatim, balancing braces and
  // skipping any nested string so a `}` inside one cannot close it early.
  private readInterpolation(): string {
    const start = this.i;
    this.i += 2;
    let depth = 1;
    while (depth > 0) {
      const c = this.src[this.i];
      if (c === undefined) this.fail("unterminated interpolation");
      if (c === '"') {
        this.parseString();
        continue;
      }
      if (c === "{") depth++;
      if (c === "}") depth--;
      this.i++;
    }
    return this.src.slice(start, this.i);
  }

  private parseIdent(): string {
    const start = this.i;
    while (IDENT.test(this.peek())) this.i++;
    if (this.i === start) this.fail("expected an identifier");
    return this.src.slice(start, this.i);
  }

  // Anything that is not an object, array or string: a resource reference,
  // a function call, a number, a boolean. Consumed as opaque source text up
  // to the first separator at nesting depth zero.
  private parseExpression(): HclExpression {
    const start = this.i;
    let depth = 0;
    for (;;) {
      const c = this.src[this.i];
      if (c === undefined) break;
      if (c === '"') {
        this.parseString();
        continue;
      }
      if (c === "(" || c === "[" || c === "{") {
        depth++;
        this.i++;
        continue;
      }
      if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break;
        depth--;
        this.i++;
        continue;
      }
      if (depth === 0) {
        if (c === "," || c === "\n" || c === "#") break;
        if (c === "/" && (this.src[this.i + 1] === "/" || this.src[this.i + 1] === "*")) {
          break;
        }
        // At depth zero an HCL expression is a single token: a reference, a
        // literal, or a call (whose parens raise the depth). A space here
        // means the next attribute has started on the same line, so stopping
        // makes parseObject reject it rather than swallowing it silently.
        if (c === " " || c === "\t" || c === "\r") break;
      }
      this.i++;
    }
    const source = this.src.slice(start, this.i).trim();
    if (!source) this.fail("expected a value");
    return new HclExpression(source);
  }
}

// ---------------------------------------------------------------------------
// Policy-document shape

export type PolicyStatement = {
  sid?: string;
  effect: "Allow" | "Deny";
  actions: string[];
  raw: { [key: string]: HclValue };
};

function asRecord(v: HclValue, what: string): { [key: string]: HclValue } {
  if (typeof v !== "string" && !Array.isArray(v) && !(v instanceof HclExpression)) {
    return v;
  }
  throw new Error(`${what} is not an object`);
}

export function stringList(v: HclValue, what: string): string[] {
  const items = Array.isArray(v) ? v : [v];
  return items.map((item) => {
    if (typeof item !== "string") {
      throw new Error(
        `${what} contains a non-literal value (${
          item instanceof HclExpression ? item.source : typeof item
        }); the boundary guard can only compare string literals`,
      );
    }
    return item;
  });
}

// Normalises a parsed policy document (from either notation) into statements.
// Throws rather than skipping when a statement is not shaped as expected.
export function statementsOf(doc: HclValue, what: string): PolicyStatement[] {
  const root = asRecord(doc, what);
  const raw = root.Statement;
  if (raw === undefined) throw new Error(`${what} has no Statement block`);
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) throw new Error(`${what} has an empty Statement block`);

  return list.map((entry, idx) => {
    const st = asRecord(entry, `${what} statement ${idx}`);
    const effect = st.Effect;
    if (effect !== "Allow" && effect !== "Deny") {
      throw new Error(`${what} statement ${idx} has no literal Effect`);
    }
    if (st.Action === undefined) {
      throw new Error(`${what} statement ${idx} has no Action`);
    }
    const actions = stringList(st.Action, `${what} statement ${idx} Action`);
    if (actions.length === 0) {
      throw new Error(`${what} statement ${idx} has an empty Action list`);
    }
    return {
      sid: typeof st.Sid === "string" ? st.Sid : undefined,
      effect,
      actions,
      raw: st,
    };
  });
}

export function allowedActions(
  doc: HclValue,
  what: string,
): { actions: Set<string>; statements: PolicyStatement[] } {
  const statements = statementsOf(doc, what);
  const actions = new Set<string>();
  // Deny statements are deliberately excluded: a permissions boundary is a
  // ceiling on Allows, and a Deny is effective whether or not the boundary
  // repeats it. Only Allows need boundary coverage.
  for (const st of statements) {
    if (st.effect !== "Allow") continue;
    for (const a of st.actions) actions.add(a);
  }
  return { actions, statements };
}
