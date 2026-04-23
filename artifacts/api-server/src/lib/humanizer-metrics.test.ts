import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateBurstiness,
  calculateLexicalFingerprint,
  calculatePunctuationDensity,
  calculateSentenceLengthDistribution,
  detectStructuralUniformity,
} from "./humanizer-metrics";

const uniformAiLikeText = `
In today's digital landscape, it is important to note that teams leverage robust workflows to navigate complexity. The process is crucial for consistency, and the process is crucial for scale. The strategy is crucial for sustainable growth.

The organization leverages robust systems to navigate every challenge. The organization leverages robust systems to navigate each milestone. The organization leverages robust systems to navigate future goals.

Moreover, in conclusion, the multifaceted landscape requires a seamless and transformative approach that underscores pivotal value in every realm.
`;

const humanLikeText = `
A missed deadline hurts.

During a chaotic launch last quarter, one onboarding team cut handoff time from twelve days to three by mapping bottlenecks on a whiteboard, rewriting two approvals, assigning one owner for sign-off, and then documenting every exception in plain language.
It worked.

Meanwhile, finance requested tighter audit trails, so product added lightweight event logging and support adjusted escalation notes before weekly reviews.
After that, incident reviews became shorter.
`;

// Fixture where every em dash from a thesaurus seems to have been invited to the party.
// Used to exercise the upper-bound punctuation-density flags.
const emDashHeavyText = `
The migration was painful — nobody denies that. The team worked late — weekends included — and the result was — at best — mixed.

Three engineers quit — two within a month — and the backlog grew — not shrank — every sprint. Stakeholders were confused — leadership was split — and the roadmap slipped — twice — before anyone noticed.
`;

test("uniform AI-like fixture fails burstiness, lexical, and structural checks", () => {
  const burstiness = calculateBurstiness(uniformAiLikeText);
  const lexical = calculateLexicalFingerprint(uniformAiLikeText);
  const uniformity = detectStructuralUniformity(uniformAiLikeText);

  assert.ok(burstiness < 0.7, `Expected low burstiness, got ${burstiness}`);
  assert.ok(lexical.score > 3, `Expected high lexical score, got ${lexical.score}`);
  assert.equal(uniformity.uniform, true);
  assert.ok(
    uniformity.reasons.some((reason) => reason.includes("Intro uses formulaic scene-setting framing")),
    `Expected intro framing reason, got: ${uniformity.reasons.join(" | ")}`
  );
});

test("human fixture passes burstiness, lexical, and structural checks", () => {
  const burstiness = calculateBurstiness(humanLikeText);
  const lexical = calculateLexicalFingerprint(humanLikeText);
  const uniformity = detectStructuralUniformity(humanLikeText);

  assert.ok(burstiness >= 0.7, `Expected burstiness >= 0.7, got ${burstiness}`);
  assert.ok(lexical.score <= 3, `Expected lexical score <= 3, got ${lexical.score}`);
  assert.equal(uniformity.uniform, false);
});

// ─── Sentence-length distribution tests ──────────────────────────────────────

test("sentence-length distribution flags AI-typical uniform text", () => {
  const dist = calculateSentenceLengthDistribution(uniformAiLikeText);

  assert.ok(dist.totalSentences > 0, "Expected some sentences in the fixture");
  assert.ok(
    dist.issues.length > 0,
    `Expected at least one distribution issue on AI-like text, got none. Dist: ${JSON.stringify(dist)}`
  );
  // The AI-like fixture has no sentences over 25 words — all cluster in the
  // medium-length zone. The long-sentence issue is the one that fires.
  assert.ok(
    dist.issues.some((issue) => issue.includes("≥25 words")),
    `Expected a long-sentence issue, got: ${dist.issues.join(" | ")}`
  );
  // Sanity check: long ratio is genuinely zero on this fixture.
  assert.equal(dist.longRatio, 0);
});

test("sentence-length distribution passes human-like text with real short and long sentences", () => {
  const dist = calculateSentenceLengthDistribution(humanLikeText);

  // Human fixture has "A missed deadline hurts." (4w) and "It worked." (2w),
  // plus the 40+ word chaotic-launch sentence.
  assert.ok(dist.shortRatio >= 0.10, `Expected short-ratio >= 0.10, got ${dist.shortRatio}`);
  assert.ok(dist.longRatio >= 0.08, `Expected long-ratio >= 0.08, got ${dist.longRatio}`);
  assert.equal(dist.issues.length, 0, `Expected no issues on human text, got: ${dist.issues.join(" | ")}`);
});

test("sentence-length distribution returns empty state for empty input", () => {
  const dist = calculateSentenceLengthDistribution("");
  assert.equal(dist.totalSentences, 0);
  assert.equal(dist.shortRatio, 0);
  assert.equal(dist.longRatio, 0);
  assert.equal(dist.issues.length, 0);
});

// ─── Punctuation-density tests ───────────────────────────────────────────────

test("punctuation density flags em-dash overuse", () => {
  const punct = calculatePunctuationDensity(emDashHeavyText);

  assert.ok(punct.wordCount > 0, "Expected some words in the fixture");
  assert.ok(
    punct.emDashPer1000 > 2.5,
    `Expected em-dash density > 2.5/1000, got ${punct.emDashPer1000}`
  );
  assert.ok(
    punct.issues.some((issue) => issue.toLowerCase().includes("em dash")),
    `Expected em-dash issue, got: ${punct.issues.join(" | ")}`
  );
});

test("punctuation density passes human-like text with normal punctuation", () => {
  const punct = calculatePunctuationDensity(humanLikeText);

  assert.equal(
    punct.issues.length,
    0,
    `Expected no punctuation issues on human text, got: ${punct.issues.join(" | ")}`
  );
});

test("punctuation density ignores markdown table separator rows when counting dashes", () => {
  const tableMarkdown = `
| Column A | Column B |
| -------- | -------- |
| Row one content here | Row two content here |
| Row three content here | Row four content here |

This paragraph has exactly one em dash — right there — and nothing else unusual.
`;
  const punct = calculatePunctuationDensity(tableMarkdown);
  // 2 em dashes in the prose; ≈ 30 words → ~67/1000. Still over the upper band,
  // but the test here is specifically that table rows didn't *inflate* the count.
  // If table separators were being counted, the number would be far higher.
  // We assert the em-dash count is what you'd predict from the prose only.
  assert.ok(
    punct.emDashPer1000 > 0,
    `Expected at least one em dash counted from prose, got ${punct.emDashPer1000}`
  );
  // Words-per-1000 math: 2 em dashes among ~30 prose words = ~67/1000.
  // If table row `-------- | --------` patterns were misread as dashes we'd see 10+ counted.
  // Loose sanity check: the raw count shouldn't be double-digits on a 30-word fixture.
  const rawCount = Math.round((punct.emDashPer1000 * punct.wordCount) / 1000);
  assert.ok(rawCount <= 3, `Expected raw em-dash count ≤ 3 (2 prose em dashes), got ${rawCount}`);
});

test("punctuation density returns zero state for empty input", () => {
  const punct = calculatePunctuationDensity("");
  assert.equal(punct.wordCount, 0);
  assert.equal(punct.emDashPer1000, 0);
  assert.equal(punct.issues.length, 0);
});
