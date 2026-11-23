import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonSchemaOf, Submission, TrialReport, Verdict, Scenario } from "../../skills/kenshu-loop/scripts/src/schema.ts";

// live smoke で判明: Claude Code 2.1.x の --json-schema は $schema(2020-12) と Ajv strict の union type を拒否する
test("--json-schema 用スキーマ: $schema を含まず、type 配列(union type)を含まない", () => {
  for (const s of [Submission, TrialReport, Verdict, Scenario]) {
    const js = JSON.stringify(jsonSchemaOf(s));
    assert.equal(js.includes('"$schema"'), false);
    assert.doesNotMatch(js, /"type":\[/);
    assert.match(js, /"anyOf"|"oneOf"|"properties"/);
  }
});
