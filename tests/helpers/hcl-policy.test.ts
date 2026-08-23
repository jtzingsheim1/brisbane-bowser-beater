import { describe, expect, it } from "vitest";
import {
  allowedActions,
  HclExpression,
  HclReader,
  statementsOf,
  type HclValue,
} from "./hcl-policy";

// The boundary drift guard is only as good as this reader. Its whole contract
// is "understand it or throw": a reader that quietly returned a partial policy
// would turn tests/infra-boundaries.test.ts green while the thing it guards
// drifted. These cover the shapes infra/*.tf actually uses, and the throws.

const parse = (src: string): HclValue => new HclReader(src).parseValue();

describe("HclReader", () => {
  it("reads the object/array/string shapes a policy document uses", () => {
    expect(
      parse(`{
        Version = "2012-10-17"
        Statement = [
          {
            Sid    = "Logs"
            Effect = "Allow"
            Action = ["logs:CreateLogStream", "logs:PutLogEvents"]
          },
        ]
      }`),
    ).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "Logs",
          Effect: "Allow",
          Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        },
      ],
    });
  });

  it("keeps a ${...} interpolation from closing the object early", () => {
    // "${aws_cloudwatch_log_group.server.arn}:*" is a real Resource value in
    // infra/lambda.tf. A reader that treated the interpolation's closing brace
    // as the object's would desync and misread every field after it.
    const out = parse(
      '{ Resource = "${aws_cloudwatch_log_group.server.arn}:*"\n Effect = "Allow" }',
    ) as Record<string, HclValue>;
    expect(out.Resource).toBe("${aws_cloudwatch_log_group.server.arn}:*");
    expect(out.Effect).toBe("Allow");
  });

  it("represents references and function calls as opaque expressions", () => {
    const out = parse(
      "{ a = local.titan_embed_arn\n b = concat([local.x], local.y)\n c = true }",
    ) as Record<string, HclValue>;
    expect(out.a).toBeInstanceOf(HclExpression);
    expect((out.a as HclExpression).source).toBe("local.titan_embed_arn");
    expect((out.b as HclExpression).source).toBe("concat([local.x], local.y)");
    expect((out.c as HclExpression).source).toBe("true");
  });

  it("skips comments, including one between object entries", () => {
    const out = parse(`{
      # a leading comment
      Effect = "Allow" # trailing
      Action = "s3:GetObject"
    }`);
    expect(out).toEqual({ Effect: "Allow", Action: "s3:GetObject" });
  });

  it("reads quoted keys and nested condition objects", () => {
    expect(
      parse('{ Condition = { ArnEquals = { "iam:PolicyARN" = "arn:x" } } }'),
    ).toEqual({ Condition: { ArnEquals: { "iam:PolicyARN": "arn:x" } } });
  });

  it("terminates an expression at a // or /* comment", () => {
    // skipTrivia understands both, so parseExpression must too, or the
    // comment text ends up inside the expression source.
    const a = parse("{ x = local.one // trailing\n y = local.two }") as Record<
      string,
      HclValue
    >;
    expect((a.x as HclExpression).source).toBe("local.one");
    expect((a.y as HclExpression).source).toBe("local.two");
    const b = parse("{ x = local.one /* mid */\n }") as Record<string, HclValue>;
    expect((b.x as HclExpression).source).toBe("local.one");
  });

  it("does not swallow a following attribute written on the same line", () => {
    // Invalid HCL, but the reader must not silently drop `b`.
    expect(parse('{ a = local.x b = "B" }')).toEqual({
      a: new HclExpression("local.x"),
      b: "B",
    });
  });

  it("reads an escaped interpolation as a literal, not a template", () => {
    expect(parse('{ a = "$${not_a_ref}" }')).toEqual({ a: "${not_a_ref}" });
  });

  it("throws on an escape it does not model rather than mangling it", () => {
    // "\u0041" decaying to the literal "u0041" would be a silent wrong
    // answer, which this reader's contract forbids.
    expect(() => parse('{ a = "\\u0041" }')).toThrow(/unsupported escape/);
  });

  it("throws rather than returning a partial object", () => {
    expect(() => parse('{ Effect = "Allow"')).toThrow(/unterminated object/);
    expect(() => parse('{ Action = ["a"')).toThrow(/unterminated array/);
    expect(() => parse('{ Effect = "Allow')).toThrow(/unterminated string/);
  });
});

describe("statementsOf", () => {
  it("throws when a document has no statements to compare", () => {
    expect(() => statementsOf({ Version: "2012-10-17" }, "doc")).toThrow(
      /no Statement block/,
    );
    expect(() => statementsOf({ Statement: [] }, "doc")).toThrow(/empty/);
  });

  it("throws when an Action is a Terraform expression, not a literal", () => {
    // A policy whose actions came from a variable cannot be compared against a
    // boundary. Failing loudly beats reporting an empty action set.
    expect(() =>
      statementsOf(
        { Statement: [{ Effect: "Allow", Action: new HclExpression("var.x") }] },
        "doc",
      ),
    ).toThrow(/non-literal/);
  });

  it("throws when a statement has no literal Effect or no Action", () => {
    expect(() =>
      statementsOf({ Statement: [{ Action: "s3:GetObject" }] }, "doc"),
    ).toThrow(/no literal Effect/);
    expect(() =>
      statementsOf({ Statement: [{ Effect: "Allow" }] }, "doc"),
    ).toThrow(/no Action/);
  });
});

describe("allowedActions", () => {
  it("collects Allow actions and ignores Deny ones", () => {
    // A permissions boundary is a ceiling on Allows; a Deny is effective
    // whether or not the boundary repeats it, so Deny actions must not count
    // toward what a boundary has to cover.
    const { actions } = allowedActions(
      {
        Statement: [
          { Effect: "Allow", Action: ["s3:GetObject"] },
          { Effect: "Deny", Action: ["s3:DeleteObject"] },
        ],
      },
      "doc",
    );
    expect([...actions]).toEqual(["s3:GetObject"]);
  });

  it("accepts a bare string Action as well as a list", () => {
    const { actions } = allowedActions(
      { Statement: { Effect: "Allow", Action: "iam:PassRole" } },
      "doc",
    );
    expect([...actions]).toEqual(["iam:PassRole"]);
  });
});
