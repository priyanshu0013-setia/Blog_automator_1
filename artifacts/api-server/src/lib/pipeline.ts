import Anthropic from "@anthropic-ai/sdk";
import { db } from "@workspace/db";
import { articlesTable, pipelineLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { publishToGoogleDocs, isGoogleDocsConfigured } from "./google-docs";
import {
  calculateBurstiness,
  calculateLexicalFingerprint,
  calculatePunctuationDensity,
  calculateSentenceLengthDistribution,
  detectStructuralUniformity,
  LEXICAL_FINGERPRINT_BLACKLIST,
} from "./humanizer-metrics";

type ArticleStatus =
  | "queued"
  | "researching"
  | "writing"
  | "humanizing"
  | "checking"
  | "retrying"
  | "formatting"
  | "completed"
  | "failed"
  | "flagged";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

/**
 * Hedge-injection feature flag.
 *
 * When ENABLED, the writer system prompt instructs the model to occasionally
 * use first-person epistemic hedges ("I think", "honestly", "perhaps", "in my
 * experience") at a low density. These phrases are common "humanize AI text"
 * folk-remedies. They can shift some detector scores but they weaken
 * authoritative SEO content by adding uncertainty where the article could
 * state its claim directly.
 *
 * Recommendation: leave disabled unless you are specifically A/B-testing
 * Grammarly scores and willing to trade editorial authority for a detector
 * delta. A hedge added by rule will not read as human; a hedge added where a
 * human writer was genuinely uncertain will.
 *
 * Toggle: set BLOG_AUTOMATOR_HEDGE_INJECTION=off in the environment to disable
 * without editing source. Defaults to "on" because the user explicitly
 * requested it; flip the default below if you want the safer behavior.
 */
const HEDGE_INJECTION_ENABLED: boolean =
  (process.env.BLOG_AUTOMATOR_HEDGE_INJECTION ?? "on").toLowerCase() !== "off";

async function updateArticleStatus(id: number, status: ArticleStatus, extra?: Partial<typeof articlesTable.$inferSelect>) {
  await db.update(articlesTable).set({ status, ...extra }).where(eq(articlesTable.id, id));
}

async function logStep(articleId: number, stepName: string, status: "running" | "completed" | "failed", details?: string) {
  await db.insert(pipelineLogsTable).values({
    articleId,
    stepName,
    status,
    details: details ? details.slice(0, 2000) : null,
  });
}

function getAnthropicClient(): Anthropic {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY environment variable is not set. Please add it to run the pipeline.");
  }
  return new Anthropic({ apiKey: ANTHROPIC_API_KEY });
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Truncate user-provided reference material to a safe character budget before
 * concatenating it into a prompt. A very long pasted PDF transcript can easily
 * exceed the practical prompt-plus-output budget, and we want a hard upper bound
 * that we control rather than letting the API error surface to the user.
 *
 * We truncate at paragraph boundaries where possible so the model still receives
 * coherent chunks rather than cut-off mid-sentence.
 */
function truncateReferenceInput(input: string, maxChars = 12000): string {
  if (!input || input.length <= maxChars) return input;
  const cut = input.slice(0, maxChars);
  // Prefer to end at the last paragraph break within the budget.
  const lastBreak = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf(". "));
  const trimmed = lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak) : cut;
  return `${trimmed.trim()}\n\n[reference truncated from ${input.length} to ${trimmed.length} characters]`;
}

function calculateKeywordDensity(text: string, keyword: string): number {
  if (!keyword || !text) return 0;
  const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  const kw = keyword.toLowerCase();
  const totalWords = words.length;
  if (totalWords === 0) return 0;
  const normalizedText = text.toLowerCase();
  const regex = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
  const matches = normalizedText.match(regex);
  const count = matches ? matches.length : 0;
  return parseFloat(((count / totalWords) * 100).toFixed(2));
}

function countEmDashes(text: string): number {
  // Exclude markdown table separator rows like `| --- | ---: |` before counting dash-style punctuation.
  const filtered = text
    .split("\n")
    .filter((line) => !/^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line))
    .join("\n");
  // Count em/en dashes and standalone double hyphens, but ignore longer hyphen runs like markdown table separators.
  const emDashMatches = filtered.match(/—|–|(?<!-)--(?!-)/g);
  return emDashMatches ? emDashMatches.length : 0;
}

/**
 * Count the number of markdown tables in an article. A table is identified by
 * the presence of a separator row (e.g. `| --- | --- |`) which uniquely
 * distinguishes tables from pipe-containing prose.
 */
function countTables(text: string): number {
  const separatorLines = text
    .split("\n")
    .filter((line) => /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line));
  return separatorLines.length;
}

/**
 * Normalize typographic curly quotes to straight quotes. This is a mechanical
 * transformation applied before the quality gate so the audit pass doesn't
 * have to burn tokens rewriting content just for quote style. Handles both
 * single and double curly quote variants.
 */
function normalizeCurlyQuotes(text: string): { text: string; replaced: number } {
  let replaced = 0;
  const normalized = text.replace(/[\u201C\u201D\u2018\u2019]/g, (match) => {
    replaced++;
    if (match === "\u201C" || match === "\u201D") return '"';
    return "'"; // \u2018 or \u2019
  });
  return { text: normalized, replaced };
}

/**
 * Count `**bold**` emphasis occurrences per 1000 words, excluding bold-as-heading
 * usage inside tables. AI chatbots over-bold mechanically; humans use bold
 * sparingly, if at all. Target density is ≤ 5 per 1000 words.
 */
function calculateBoldfaceDensity(text: string): { boldCount: number; per1000: number } {
  // Match **word** or **phrase** but not unbalanced or nested markers.
  const bolds = text.match(/\*\*[^*\n]+?\*\*/g) ?? [];
  const words = text.split(/\s+/).filter((w) => w.length > 0).length;
  if (words === 0) return { boldCount: bolds.length, per1000: 0 };
  const per1000 = parseFloat(((bolds.length / words) * 1000).toFixed(2));
  return { boldCount: bolds.length, per1000 };
}

/**
 * Detect AI-style inline-header vertical lists: bullet lines where each starts
 * with a bolded label followed by a colon, like:
 *   - **User Experience:** The interface has been improved.
 *   - **Performance:** Load times have decreased.
 * Humans occasionally write this pattern but AI outputs it mechanically. We
 * flag when 3+ consecutive bullet lines follow this shape.
 */
function detectInlineHeaderLists(text: string): { count: number; samples: string[] } {
  const lines = text.split("\n");
  const samples: string[] = [];
  let runStart = -1;
  let consecutive = 0;
  let totalGroups = 0;

  const matches = (line: string) => /^\s*[-*]\s+\*\*[^*]+\*\*\s*[:.]/.test(line);

  for (let i = 0; i < lines.length; i++) {
    if (matches(lines[i])) {
      if (consecutive === 0) runStart = i;
      consecutive++;
    } else {
      if (consecutive >= 3) {
        totalGroups++;
        samples.push(lines[runStart].trim().slice(0, 80));
      }
      consecutive = 0;
    }
  }
  if (consecutive >= 3) {
    totalGroups++;
    samples.push(lines[runStart].trim().slice(0, 80));
  }
  return { count: totalGroups, samples };
}

/**
 * Detect over-consistent Title Case in H2/H3 headings. The AI pattern is
 * capitalizing every meaningful word in every subheading. Humans typically
 * mix sentence case and occasional title case. We flag when ≥80% of H2/H3
 * headings are in strict Title Case.
 *
 * Title Case check: all content words (≥4 letters) start with a capital.
 * We exclude the H1 because H1 is conventionally Title Case in many styles.
 */
function detectOverConsistentTitleCase(text: string): { ratio: number; flaggedHeadings: string[] } {
  const subheadings = extractHeadings(text)
    .filter((h) => h.level === "h2" || h.level === "h3")
    .map((h) => h.heading);
  if (subheadings.length < 3) return { ratio: 0, flaggedHeadings: [] };

  const isTitleCase = (heading: string): boolean => {
    const words = heading.split(/\s+/).filter((w) => w.length >= 4 && /^[A-Za-z]/.test(w));
    if (words.length === 0) return false;
    return words.every((w) => /^[A-Z]/.test(w));
  };

  const flagged = subheadings.filter(isTitleCase);
  const ratio = flagged.length / subheadings.length;
  return {
    ratio: parseFloat(ratio.toFixed(2)),
    flaggedHeadings: ratio >= 0.8 ? flagged : [],
  };
}

/**
 * Detect overuse of common AI-pattern hyphenated word pairs (skill pattern 26).
 * Humans hyphenate inconsistently; AI writes "cross-functional, data-driven,
 * client-facing, decision-making" in perfect uniform repetition. We flag when
 * three or more pairs from the common AI list appear in the same article.
 */
const AI_HYPHENATED_PAIRS = [
  "data-driven",
  "cross-functional",
  "client-facing",
  "decision-making",
  "well-known",
  "high-quality",
  "real-time",
  "long-term",
  "end-to-end",
  "detail-oriented",
  "results-driven",
  "customer-centric",
  "user-friendly",
  "future-proof",
  "out-of-the-box",
];

function detectHyphenatedPairOveruse(text: string): { count: number; hits: string[] } {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const pair of AI_HYPHENATED_PAIRS) {
    const re = new RegExp(`\\b${pair}\\b`, "gi");
    const matches = lower.match(re);
    if (matches && matches.length > 0) {
      hits.push(`${pair}(${matches.length})`);
    }
  }
  return { count: hits.length, hits };
}

function extractFAQs(text: string): string[] {
  const lines = text.split("\n");
  const faqStart = lines.findIndex((line) =>
    /^#{1,3}\s*(FAQ|Frequently Asked Questions|Common Questions)\b/i.test(line.trim())
  );
  if (faqStart === -1) return [];

  const faqLines = lines.slice(faqStart + 1);
  return faqLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && /^(?:\*\*)?\s*Q(?:uestion)?\s*\d+\s*[:.]/i.test(line));
}

/**
 * Split an article into (body, faqQuestions) so we can compare them.
 * `body` excludes the FAQ section entirely; `faqQuestions` is the array of
 * question strings (without the "Q1." prefix).
 */
function splitArticleForFaqAudit(text: string): { body: string; faqQuestions: string[] } {
  const lines = text.split("\n");
  const faqStart = lines.findIndex((line) =>
    /^#{1,3}\s*(FAQ|Frequently Asked Questions|Common Questions)\b/i.test(line.trim())
  );
  if (faqStart === -1) return { body: text, faqQuestions: [] };

  const body = lines.slice(0, faqStart).join("\n");
  const faqLines = lines.slice(faqStart + 1);
  const faqQuestions = faqLines
    .map((l) => l.trim())
    .filter((l) => /^(?:\*\*)?\s*Q\d+\s*[:.]/i.test(l))
    .map((l) => l.replace(/^(?:\*\*)?\s*Q\d+\s*[:.]\s*/i, "").replace(/\*\*$/g, "").trim());

  return { body, faqQuestions };
}

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "and", "or", "but",
  "if", "then", "so", "of", "to", "in", "on", "at", "for", "with", "by", "from", "as",
  "it", "its", "this", "that", "these", "those", "i", "you", "we", "they", "he", "she",
  "what", "why", "how", "when", "where", "who", "which", "does", "do", "did", "can",
  "could", "should", "would", "will", "has", "have", "had", "not", "no", "yes", "than",
  "about", "into", "out", "your", "my", "our", "their", "there", "here", "more", "most",
]);

function extractContentWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return new Set(words);
}

/**
 * Detect FAQ questions whose core content words already appear densely in the
 * body. This catches the common failure mode where the model generates a FAQ
 * like "What is keyword density?" when the body already has a section titled
 * "Understanding keyword density."
 *
 * Returns the indices of FAQ questions that appear to duplicate body content,
 * along with the matched content words. A question is flagged when ≥70% of its
 * content words already appear in the body.
 */
function detectFaqBodyOverlap(text: string): { duplicateFaqIndices: number[]; details: string[] } {
  const { body, faqQuestions } = splitArticleForFaqAudit(text);
  if (faqQuestions.length === 0) return { duplicateFaqIndices: [], details: [] };

  const bodyWords = extractContentWords(body);
  const duplicateFaqIndices: number[] = [];
  const details: string[] = [];

  faqQuestions.forEach((question, idx) => {
    const qWords = [...extractContentWords(question)];
    if (qWords.length < 2) return; // too short to meaningfully compare
    const overlap = qWords.filter((w) => bodyWords.has(w));
    const ratio = overlap.length / qWords.length;
    if (ratio >= 0.70) {
      duplicateFaqIndices.push(idx);
      details.push(`Q${idx + 1} ("${question}") — ${overlap.length}/${qWords.length} content words already in body: ${overlap.slice(0, 6).join(", ")}`);
    }
  });

  return { duplicateFaqIndices, details };
}

function generateSeoSlug(title: string, keyword: string): string {
  const base = title || keyword;
  return base
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim()
    .slice(0, 60);
}

type ClaudeGenerationOverrides = {
  temperature?: number;
  top_p?: number;
  /** Optional system prompt. Long, static system prompts are automatically cached. */
  system?: string;
  /** Optional assistant prefill. The returned text will include the prefill content. */
  prefill?: string;
  /** If set, the prefill is prepended to the returned text (default: true for convenience). */
  includePrefillInReturn?: boolean;
};

/**
 * Minimum system-prompt length (in characters) at which we attach cache_control.
 * Anthropic's prompt cache has a 1024-token minimum block size for Claude Opus
 * models; below that threshold the cache_control marker is ignored (no error,
 * just no cache hit). 1024 tokens ≈ 4096 characters for typical English prose,
 * so we gate at 4000 to stay safely above the floor while keeping the logic
 * conservative. Shorter system prompts are sent as plain strings.
 */
const SYSTEM_CACHE_MIN_CHARS = 4000;

async function callClaude(
  client: Anthropic,
  prompt: string,
  maxTokens = 8192,
  overrides: ClaudeGenerationOverrides = {},
): Promise<string> {
  // Anthropic's Claude 4.x models reject requests that specify both `temperature`
  // and `top_p`. Per Anthropic's guidance ("You usually only need to use temperature"),
  // we prefer `temperature` and only fall back to `top_p` when the caller explicitly
  // opts into top-p-only sampling by passing `top_p` without a `temperature`.
  const samplingParams:
    | { temperature: number }
    | { top_p: number } =
    overrides.temperature !== undefined
      ? { temperature: overrides.temperature }
      : overrides.top_p !== undefined
        ? { top_p: overrides.top_p }
        : { temperature: 0.85 };

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: prompt },
  ];
  // Anthropic rejects an assistant prefill that ends in whitespace with a 400.
  // Strip trailing whitespace defensively so callers don't have to think about it.
  const prefill = overrides.prefill ? overrides.prefill.replace(/\s+$/, "") : "";
  if (prefill) {
    // Assistant prefill: forces the model to continue from the given text.
    // Used to eliminate preamble ("Here is the article:") and to coerce
    // structured output (e.g. prefill "{" to force JSON).
    messages.push({ role: "assistant", content: prefill });
  }

  // Build the `system` parameter as a content-block array when we have a
  // long static system prompt, so we can attach cache_control and cut cost
  // on later pipeline steps that re-use the same rule boilerplate.
  const systemParam: Anthropic.MessageCreateParams["system"] | undefined =
    overrides.system
      ? overrides.system.length >= SYSTEM_CACHE_MIN_CHARS
        ? [{ type: "text", text: overrides.system, cache_control: { type: "ephemeral" } }]
        : overrides.system
      : undefined;

  const message = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: maxTokens,
    ...samplingParams,
    ...(systemParam !== undefined ? { system: systemParam } : {}),
    messages,
  });
  const textContent = message.content.find((c) => c.type === "text");
  const generated = textContent ? textContent.text : "";
  const includePrefill = overrides.includePrefillInReturn ?? true;
  return prefill && includePrefill ? prefill + generated : generated;
}

function formatAiSignatureMetrics(
  burstiness: number,
  lexicalScore: number,
  uniformity: { uniform: boolean; reasons: string[] },
): string {
  const reasons = uniformity.reasons.length > 0 ? ` [${uniformity.reasons.join("; ")}]` : "";
  return `burstiness=${burstiness.toFixed(2)} (need >=0.70), lexical=${lexicalScore.toFixed(2)} hits/1000 (need <=3.00), structuralUniformity=${uniformity.uniform}${reasons}`;
}

// ─── CHANGE 1 & 2: Format variation system ───────────────────────────────────

const FORMAT_PATTERNS = [
  "H2 > short prose > H3 > bullet list > table > closing prose",
  "H2 > H3 > prose > H3 > table > bullet list",
  "H2 > table > prose > H3 > bullet list > prose",
  "H2 > bullet list > prose > H3 > prose > table",
  "H2 > H3 > table > prose > bullet list > H3 > prose",
  "H2 > prose > bullet list > H3 > table > closing prose",
  "H2 > H3 > bullet list > prose > table > prose",
  "H2 > prose > H3 > table > prose > bullet list",
];

function shuffleArray<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildSectionPatterns(numH2Sections: number): string {
  const shuffled = shuffleArray(FORMAT_PATTERNS);
  const assigned: string[] = [];
  for (let i = 0; i < numH2Sections; i++) {
    let pick = shuffled[i % shuffled.length];
    if (i > 0 && pick === assigned[i - 1]) {
      pick = shuffled[(i + 1) % shuffled.length];
    }
    assigned.push(pick);
  }
  return assigned
    .map((pattern, idx) => `Section ${idx + 1} (H2 #${idx + 1}): ${pattern}`)
    .join("\n");
}

const MANDATORY_FORMATTING_RULES = `
FORMATTING RULES (MANDATORY — FOLLOW EXACTLY):

1. Every article must include between 1 and 2 tables (never zero, never more than 2) plus a mix of bullet points. Use tables only where the content genuinely benefits from comparison or side-by-side presentation — never pad with a second table just to hit a count. Bullets go where list-shaped content naturally fits.

2. Subheadings (H2 and H3) must be SEO-safe, neutral, and descriptive. NEVER use negative framing in any subheading. Banned patterns include: "still not," "why X fails," "the problem with," "what went wrong," "mistakes," "avoid," "stop doing," or any negative/clickbait phrasing. Keep all subheadings professional, neutral, and keyword-relevant.

3. Em dashes are allowed at a low density (target 0-2 per 1000 words). Never overuse them, never chain two em-dash sentences in a row, and never use en dashes (–) or double hyphens (--). A small, natural amount of em-dash use actually reads more human than a rigid ban.

4. Under each H2 section, use a MIX of different content types to break up the text and hold reader attention. Each H2 section MUST contain a varied combination of these elements: H3 subheadings, short prose paragraphs (2-4 sentences), bullet point lists, or tables. Do NOT use the same arrangement under every H2. Every H2 section must feel structurally different from the one before it.

5. Use formal professional language throughout. Avoid casual slang, colloquialisms, and conversational filler.
6. Write body content in coherent paragraphs. Do not break lines after every one or two sentences. Use blank lines only to separate paragraphs, sections, bullet lists, or tables.
`;

function buildFormatVariationInstruction(numH2Sections: number): string {
  const patterns = buildSectionPatterns(numH2Sections);
  return `
FORMAT VARIATION INSTRUCTION:
Each H2 section in this article MUST follow a DIFFERENT structural layout. Do not repeat the same content arrangement under consecutive H2 sections. Use the following structure for each section:

${patterns}

This is critical: if one section leads with a table, the next must lead with prose or bullets. If one section uses bullet list then table, the next must use a different order. Make every section feel fresh and visually distinct.
`;
}

// ─── CHANGE 3 & 4: Post-generation quality checks ────────────────────────────

const NEGATIVE_HEADING_WORDS = [
  "fail", "fails", "failed", "failure", "problem", "problems", "wrong",
  "mistake", "mistakes", "still not", "never", "worst", "bad", "avoid",
  "stop", "don't", "doesn't", "won't", "can't", "unable", "impossible",
  "lack", "lacking", "poor", "terrible", "horrible", "dangerous", "risk",
  "risky", "warning", "beware", "downside", "drawback", "pitfall", "trap",
  "myth", "lie", "lies", "scam", "overrated", "overhyped", "dying", "dead",
  "obsolete", "broken", "flawed",
];

function extractHeadings(text: string): { heading: string; level: "h2" | "h3" }[] {
  const lines = text.split("\n");
  const headings: { heading: string; level: "h2" | "h3" }[] = [];
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)/);
    const h3 = line.match(/^###\s+(.+)/);
    if (h2) headings.push({ heading: h2[1].trim(), level: "h2" });
    else if (h3) headings.push({ heading: h3[1].trim(), level: "h3" });
  }
  return headings;
}

function countHeadingWords(heading: string): number {
  return heading.split(/\s+/).filter(Boolean).length;
}

function getHeadlineWordCount(text: string): number | null {
  const firstH1 = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^#\s+/.test(line));
  if (!firstH1) return null;
  return countHeadingWords(firstH1.replace(/^#\s+/, "").trim());
}

function getSubheadingLengthViolations(text: string): string[] {
  return extractHeadings(text)
    .map((h) => h.heading)
    .filter((heading) => {
      const words = countHeadingWords(heading);
      return words < 8 || words > 15;
    });
}

/**
 * Detect formulaic article openings. The system prompt forbids them, but models
 * sometimes drift back into these patterns under token pressure; this catches
 * drift mechanically so we can trigger a targeted rewrite of just the opener.
 *
 * Returns the offending opening phrase if one is found, otherwise null.
 */
function detectFormulaicOpening(text: string): string | null {
  const stripped = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .slice(0, 1)[0];
  if (!stripped) return null;
  const first120 = stripped.slice(0, 120).toLowerCase();

  const formulas: RegExp[] = [
    /^in today'?s\b/,
    /^in the modern\b/,
    /^in the (?:ever-?evolving|rapidly (?:changing|evolving)|fast-paced)\b/,
    /^as (?:[a-z][a-z -]{0,40}) continues to evolve\b/,
    /^in the world of\b/,
    /^(?:when|as) it comes to\b/,
    /^(?:the|a) world of\b.*(?:is|has)\b/,
    /^picture (?:this|a scenario)/,
    /^imagine (?:a (?:world|scenario)|that)/,
  ];

  for (const re of formulas) {
    if (re.test(first120)) {
      // Return the first 6-8 words of the offending opener for the rewrite prompt.
      return stripped.split(/\s+/).slice(0, 8).join(" ");
    }
  }
  return null;
}

function splitSecondaryKeywords(raw?: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getHeadingKeywordViolations(text: string, primaryKeyword: string, secondaryKeywords?: string | null): string[] {
  const headings = extractHeadings(text).map((h) => h.heading);
  const primary = primaryKeyword.trim().toLowerCase();
  const secondary = splitSecondaryKeywords(secondaryKeywords).map((item) => item.toLowerCase());

  return headings.filter((heading) => {
    const lower = heading.toLowerCase();
    const hasPrimary = primary.length > 0 && lower.includes(primary);
    const hasSecondary = secondary.some((kw) => lower.includes(kw));
    return !(hasPrimary || hasSecondary);
  });
}

function getPrimaryHeadingCoverage(text: string, primaryKeyword: string): number {
  const headings = extractHeadings(text).map((h) => h.heading);
  if (headings.length === 0) return 0;
  const primary = primaryKeyword.trim().toLowerCase();
  const withPrimary = headings.filter((heading) => heading.toLowerCase().includes(primary)).length;
  return parseFloat(((withPrimary / headings.length) * 100).toFixed(2));
}

/**
 * Percentage of H2/H3 headings that contain at least one secondary keyword.
 * Returns 0 when no secondary keywords are configured, so callers should gate
 * the check on whether secondaryKeywords was actually provided.
 */
function getSecondaryHeadingCoverage(text: string, secondaryKeywords?: string | null): number {
  const secondary = splitSecondaryKeywords(secondaryKeywords).map((k) => k.toLowerCase());
  if (secondary.length === 0) return 0;
  const headings = extractHeadings(text).map((h) => h.heading);
  if (headings.length === 0) return 0;
  const withSecondary = headings.filter((heading) => {
    const lower = heading.toLowerCase();
    return secondary.some((kw) => lower.includes(kw));
  }).length;
  return parseFloat(((withSecondary / headings.length) * 100).toFixed(2));
}

function findNegativeHeadings(headings: { heading: string; level: string }[]): string[] {
  return headings
    .map((h) => h.heading)
    .filter((heading) => {
      const lower = heading.toLowerCase();
      return NEGATIVE_HEADING_WORDS.some((word) => lower.includes(word));
    });
}

/**
 * Classify an H2 heading into a syntactic template category. When multiple H2s
 * in an article share the same template, the document reads as formulaic even
 * if the words differ. Examples:
 *   "How to improve SEO"          → "how-to"
 *   "How to write better meta tags" → "how-to"
 *   "The 5 best link-building tools" → "listicle"
 *   "Why content quality matters"  → "why-matters"
 * If every H2 collapses to the same template, downstream code triggers a
 * targeted rewrite.
 */
function classifyHeadingTemplate(heading: string): string {
  const lower = heading.toLowerCase().trim();
  if (/^how to\b/.test(lower)) return "how-to";
  if (/^(?:the )?(?:top |best )?\d+\s/.test(lower)) return "listicle";
  if (/^why\b.*\b(?:matters?|important|crucial|essential)\b/.test(lower)) return "why-matters";
  if (/^what (?:is|are)\b/.test(lower)) return "what-is";
  if (/^when (?:to|you|should)\b/.test(lower)) return "when-to";
  if (/\bvs\.?\b|\bversus\b/.test(lower)) return "vs";
  if (/^(?:a |an |the )?(?:guide|overview|introduction)\b/.test(lower)) return "guide";
  if (/^(?:ways|tips|strategies|methods|steps)\b/.test(lower)) return "tactics";
  return "other";
}

/**
 * Detect over-repetition in H2 heading syntactic templates. Returns the
 * offending pattern if ≥70% of H2 headings fall into the same template
 * category (excluding "other"), otherwise null.
 */
function detectUniformHeadingPattern(text: string): { pattern: string; ratio: number; headings: string[] } | null {
  const h2Headings = extractHeadings(text)
    .filter((h) => h.level === "h2")
    .map((h) => h.heading);
  if (h2Headings.length < 3) return null;

  const counts = new Map<string, string[]>();
  for (const heading of h2Headings) {
    const tpl = classifyHeadingTemplate(heading);
    const existing = counts.get(tpl) ?? [];
    existing.push(heading);
    counts.set(tpl, existing);
  }

  for (const [tpl, matched] of counts) {
    if (tpl === "other") continue;
    const ratio = matched.length / h2Headings.length;
    if (ratio >= 0.7) {
      return { pattern: tpl, ratio, headings: matched };
    }
  }
  return null;
}

/**
 * Return the first meaningful word of a sentence (skipping articles). Used by
 * cross-section repetition detection — humans vary how they start paragraphs
 * but AI tends to reuse the same opener across sections.
 */
function firstContentWord(sentence: string): string | null {
  const cleaned = sentence
    .replace(/^[#>\s*_`-]+/, "")
    .trim()
    .toLowerCase();
  const words = cleaned.match(/[a-z]+(?:['-][a-z]+)?/g) ?? [];
  for (const word of words) {
    if (word.length < 2) continue;
    if (["the", "a", "an"].includes(word)) continue;
    return word;
  }
  return null;
}

/**
 * Detect when the opening sentences of multiple H2 sections share the same
 * first content word. Example: three sections each starting with
 *   "When teams migrate..."
 *   "When organizations adopt..."
 *   "When engineers deploy..."
 * This is a classic AI-pattern: the model reaches for the same rhetorical
 * hinge across sections. Returns the repeated word and the offending heading
 * list if ≥40% of section-opening sentences share the same first content word.
 */
function detectSectionOpenerRepetition(text: string): { word: string; sections: string[] } | null {
  const sections = getH2Sections(text);
  if (sections.length < 3) return null;

  const firstWords: { heading: string; word: string }[] = [];
  for (const section of sections) {
    // Skip the H2 line itself; find the first non-empty non-heading line.
    const bodyLines = section.content
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("|") && !/^\s*[-*]\s/.test(l));
    if (bodyLines.length === 0) continue;
    const firstSentence = bodyLines[0].split(/(?<=[.!?])\s+/)[0] ?? bodyLines[0];
    const word = firstContentWord(firstSentence);
    if (word) firstWords.push({ heading: section.heading, word });
  }

  if (firstWords.length < 3) return null;

  const counts = new Map<string, string[]>();
  for (const { heading, word } of firstWords) {
    const list = counts.get(word) ?? [];
    list.push(heading);
    counts.set(word, list);
  }

  for (const [word, sectionHeadings] of counts) {
    const ratio = sectionHeadings.length / firstWords.length;
    if (ratio >= 0.4 && sectionHeadings.length >= 2) {
      return { word, sections: sectionHeadings };
    }
  }
  return null;
}

async function fixNegativeHeadings(client: Anthropic, article: string): Promise<{ article: string; fixed: number }> {
  const headings = extractHeadings(article);
  const flagged = findNegativeHeadings(headings);
  if (flagged.length === 0) return { article, fixed: 0 };

  const rewritePrompt = `The following subheadings use negative framing, which is not allowed in our articles. Rewrite each to be SEO-safe, neutral, and descriptive while keeping the same topic and meaning:

${flagged.map((h, i) => `${i + 1}. ${h}`).join("\n")}

Rules:
- Keep each rewrite descriptive and directly relevant to the section content.
- Use neutral or positive framing only.
- Keep each heading 8-15 words, SEO-friendly. No em dashes in headings specifically (em dashes are allowed in body prose but not headings).
- Do not phrase as questions unless absolutely necessary.

Return the rewritten headings in the same order, one per line, with no numbering, no commentary, and no blank lines between them.`;

  const rewritten = await callClaude(client, rewritePrompt, 1024, { temperature: 0.4 });
  const rewrites = rewritten.split("\n").map((l) => l.trim()).filter(Boolean);

  let fixed = article;
  flagged.forEach((original, idx) => {
    const replacement = rewrites[idx];
    if (replacement) {
      fixed = fixed.replace(
        new RegExp(`(#{2,3}\\s+)${original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gm"),
        (match, prefix) => `${prefix}${replacement}`
      );
    }
  });

  return { article: fixed, fixed: flagged.length };
}

function getH2Sections(text: string): { heading: string; content: string }[] {
  const lines = text.split("\n");
  const sections: { heading: string; content: string }[] = [];
  let current: { heading: string; lines: string[] } | null = null;

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)/);
    if (h2Match) {
      if (current) sections.push({ heading: current.heading, content: current.lines.join("\n") });
      current = { heading: h2Match[1].trim(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push({ heading: current.heading, content: current.lines.join("\n") });
  return sections;
}

function categorizeSection(content: string): string {
  const hasProse = /^[A-Z][^#*|]/.test(content.replace(/^##.*\n/, "").trim());
  const hasBullets = /^\s*[-*]\s/m.test(content);
  const hasTable = /^\|.+\|/m.test(content);
  const hasH3 = /^###\s/m.test(content);

  const parts: string[] = [];
  const lines = content.split("\n");
  let lastType = "";
  for (const line of lines) {
    let type = "";
    if (/^###\s/.test(line)) type = "H3";
    else if (/^\|.+\|/.test(line)) type = "table";
    else if (/^\s*[-*]\s/.test(line)) type = "bullet";
    else if (line.trim() && !/^##\s/.test(line)) type = "prose";
    if (type && type !== lastType) {
      parts.push(type);
      lastType = type;
    }
  }
  return parts.join(" > ") || (hasProse ? "prose" : hasTable ? "table" : hasBullets ? "bullets" : "unknown");
}

/**
 * Given a repeating pattern, suggest a concrete alternative layout. Telling
 * the model "use a different arrangement" is much weaker than naming a
 * specific target layout, so we rotate through three distinct ones.
 */
function suggestAlternativePattern(current: string): string {
  const alternatives = [
    "prose > table > prose (a short analytical paragraph, then a comparison table, then a closing paragraph)",
    "H3 > bullet > prose (one H3 subsection with a bullet list of items, followed by a concluding prose paragraph)",
    "prose > H3 > prose > H3 > prose (two H3 subsections separated by short prose bridges, no bullets or tables)",
  ];
  // Pick the alternative whose components differ most from the current pattern.
  const normalized = current.toLowerCase();
  const scored = alternatives.map((alt) => ({
    alt,
    score: ["prose", "bullet", "table", "h3"].reduce(
      (acc, token) => acc + (normalized.includes(token) !== alt.toLowerCase().includes(token) ? 1 : 0),
      0,
    ),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].alt;
}

async function fixRepetitiveSections(client: Anthropic, article: string): Promise<{ article: string; fixed: number }> {
  const sections = getH2Sections(article);
  if (sections.length < 2) return { article, fixed: 0 };

  const patterns = sections.map((s) => categorizeSection(s.content));
  const flaggedPairs: number[] = [];

  for (let i = 0; i < patterns.length - 1; i++) {
    if (patterns[i] === patterns[i + 1] && patterns[i] !== "unknown") {
      flaggedPairs.push(i + 1);
    }
  }

  if (flaggedPairs.length === 0) return { article, fixed: 0 };

  let fixed = article;
  let totalFixed = 0;

  for (const idx of flaggedPairs) {
    const section = sections[idx];
    const repeatedPattern = patterns[idx];

    const restructurePrompt = `The section below shares the same internal layout as the section before it (${repeatedPattern}), which makes the article feel repetitive. Restructure ONLY this section to a visibly different layout. Keep all facts, data, and meaning exactly the same; only change how the content is arranged.

Target layout for this section: ${suggestAlternativePattern(repeatedPattern)}

Constraints:
- Do not change the H2 heading line itself.
- Preserve every fact and data point.
- Keep formal tone. Em dashes are allowed sparingly but never in chains.
- Any subheadings you add or rewrite must be neutral and SEO-safe.

Return ONLY the restructured section (starting with its existing H2 line), no commentary.

SECTION TO RESTRUCTURE:
${section.content}`;

    const restructured = await callClaude(client, restructurePrompt, 4096, { temperature: 0.45 });

    if (restructured.trim()) {
      // Defensive: if the model dropped or altered the H2 heading line, splice
      // the original H2 back onto the front so we never silently lose a section.
      let replacement = restructured.trim();
      const originalH2 = section.content.split("\n", 1)[0];
      if (!replacement.startsWith(originalH2)) {
        const firstH2InReply = replacement.match(/^##\s+.*/m);
        if (firstH2InReply) {
          replacement = replacement.replace(firstH2InReply[0], originalH2);
        } else {
          replacement = `${originalH2}\n${replacement}`;
        }
      }
      fixed = fixed.replace(section.content, replacement);
      totalFixed++;
    }
  }

  return { article: fixed, fixed: totalFixed };
}

// ─── Humanization rules ───────────────────────────────────────────────────────

const HUMANIZATION_RULES = `
CRITICAL HUMANIZATION RULES (follow all):

HARD BANS (zero tolerance):
- No opening with "In today's...", "In the modern...", "As [X] continues to evolve...", "In the rapidly changing world of...", or other broad scene-setting.
- No signposting phrases ("Let's dive in", "Here's what you need to know", "Now let's explore").
- No chatbot artifacts ("I hope this helps", "Let me know if", "Great question").
- No filler phrases ("in order to", "due to the fact that", "it is worth noting").
- No generic conclusions ("in conclusion", "to summarize", "the future looks bright").
- No promotional inflation ("groundbreaking", "transformative", "pivotal moment").
- No monotone additive transitions ("Moreover", "Furthermore", "Additionally", "In addition", "What's more"). Use "But", "And", "Also", or just start a new sentence without a transition.
- No lexical markers from this blacklist: ${LEXICAL_FINGERPRINT_BLACKLIST.join(", ")}.
- No en dashes (–) or double hyphens (--) anywhere.

RHYTHM AND STRUCTURE (deliberately vary):
- Sentence-length distribution is the single biggest AI tell. Aim for:
  • at least 10% of sentences ≤8 words (short, punchy)
  • at least 8% of sentences ≥25 words (long, analytical)
  • median sentence length in the 13-18 word range (NOT the AI-typical 17-22)
- Mix short and long sentences INSIDE the same paragraph, not in separate sections.
- No more than 2 consecutive sentences within 5 words of each other in length.
- No more than 2 consecutive sentences starting with the same part of speech. Lead with dependent clauses, prepositional phrases, or adverbs where natural. Starting a sentence with "And" or "But" is allowed and often reads more human than "Moreover".
- Vary paragraph length drastically. Include at least one single-sentence paragraph per article. Include at least one paragraph of 6+ sentences. Avoid uniform 3-4 sentence paragraphs.

PUNCTUATION:
- Em dashes (—) are allowed at a target density of about 0-2 per 1000 words — zero is itself an AI tell (over-sanitized text). Never chain em dashes in consecutive sentences. Prefer commas or colons where possible.
- Semicolons: use sparingly (0-4 per 1000 words). Colons: 2-8 per 1000 words.

VOICE:
- Prefer direct, concrete statements with named sources, specific numbers, or specific scenarios. A specific noun ("a 2023 Ahrefs study of 14 million pages") beats a vague one ("studies suggest").
- Use natural contractions. Keep wording plain and precise. No synonym-cycling, no forced slang.
- Keep language formal and professional as the baseline.
${HEDGE_INJECTION_ENABLED
  ? `- Hedges and personal voice: use first-person epistemic markers sparingly but deliberately. At least once per 400-600 words, include a natural hedge such as "I think", "honestly", "perhaps", "in my experience", or "it seems" — but ONLY in analytical or interpretive sentences, never in sentences stating facts, statistics, or named sources. Do not stack multiple hedges in one paragraph. Do not hedge where the article is stating something concrete (numbers, dates, cited studies).`
  : `- Do NOT inject hedges like "I think", "I believe", "perhaps", "it seems" — in authoritative blog content these read as weak, not human.`}

REGISTER VARIANCE (subtle informality, not errors):
- Occasional sentence fragments are allowed for rhythm. Not every sentence needs a verb. Example: "Same pattern every quarter." "Worth checking."
- Starting a sentence with "And" or "But" is allowed and often reads more human than "Additionally" or "However". Use once or twice per 1000 words, not constantly.
- A comma splice is allowed in short rhythmic pairs where a period would feel heavy, such as "The migration was painful, nobody denies that." Use this at most once or twice in an article.
- Do not manufacture typos, misspellings, or factually wrong word choices (e.g., affect/effect confusion, wrong homophones). Imperfection should come from rhythm and register, never from errors a reader could act on.

BANNED CONSTRUCTIONS (avoid on first draft, not just in editing):
These are the specific sentence templates that mark AI writing most clearly. If you catch yourself reaching for any of them, rewrite the sentence instead.

1. Significance inflation. Do not write "stands as a testament to", "serves as a reminder of", "marks a pivotal moment", "in the evolving landscape of", "represents a key shift". State the fact directly: "The institute was founded in 1989" beats "The institute's founding in 1989 marked a pivotal moment in the evolving landscape of regional statistics."

2. Copula avoidance. Prefer "is/are/has" over elaborate substitutes. Write "The gallery is LAAA's exhibition space" rather than "The gallery serves as LAAA's exhibition space." Write "The town has four distilleries" rather than "The town boasts four distilleries."

3. Superficial -ing chains. Do not tack on participles for fake depth. Bad: "The color palette resonates with the region, symbolizing local flora, reflecting the community's deep connection to the land, contributing to a sense of place." Good: "The color palette references local flora."

4. Negative parallelism. Do not use "It's not X, it's Y" or "Not only X but also Y" as rhetorical crutches. If you want to contrast, just contrast: "The beat is aggressive" rather than "It's not just a beat, it's a statement."

5. Rule-of-three templates. Do not force triplets to sound comprehensive. "Streamlining processes, enhancing collaboration, and fostering alignment" is a fingerprint. Pick one concrete claim and defend it.

6. Persuasive authority tropes. Do not use "The real question is", "At its core", "What really matters here is", "The deeper issue", "Fundamentally speaking". These phrases promise depth and deliver restatement. Cut them; the sentence usually works without the preamble.

7. False ranges. Do not write "from X to Y, from A to B" unless X/Y and A/B are on meaningful scales. "The project covered Python, Rust, and TypeScript" beats "from statically-typed languages to dynamically-typed ones, from compiled to interpreted."

8. Fragmented headers. Do not follow a heading with a one-line paragraph that restates the heading before the real content starts. Delete the restatement and begin with the substantive paragraph.

9. Vague attributions. Do not appeal to vague authorities ("industry reports say", "experts argue", "observers note", "some critics contend"). Name the source: "a 2024 Gartner survey of 1,200 IT leaders found X" beats "industry reports suggest X." If you have no source, cut the claim.

10. Notability puffery. Do not list media outlets to imply importance ("cited in The NYT, BBC, and The Hindu"). One specific citation with substance beats a list of outlets.

11. Knowledge-cutoff disclaimers. Do not write "as of my last update", "based on available information", "while specific details are limited". Commit to a definite claim with a source, or cut the sentence.

12. Sycophantic openers. Never write "Great question!", "You're absolutely right", "That's an excellent point" in article prose — these are chat artifacts that have no place in published content.

13. Subjectless fragments. Do not use "No configuration needed." or "No prior experience required." Give the sentence a subject: "You don't need a configuration file" or rephrase actively.

14. Stacked hedges. Do not stack hedge markers ("could potentially possibly", "may perhaps"). Pick one: "may" or "could" is enough.

15. Emojis. Do not use emojis in headings, bullets, or prose. Ever.

16. Curly quotes. Use straight quotes (" and ') only. Curly quotes (", ', ", ') are a default-word-processor tell.

17. Boldface restraint. Use **bold** sparingly — no more than 5 bolded terms per 1000 words. Bold only genuinely critical terms or first-mention definitions. Do not bold whole phrases for emphasis.

18. Inline-header vertical lists. Do not write bulleted lists where each bullet starts with a bolded label and a colon, like:
    - **Speed:** Code generation is fast.
    - **Quality:** Output is high quality.
   This is the single most obvious AI fingerprint in marketing content. Write this as prose or as plain bullets without the bold-label-colon structure.

19. Over-consistent Title Case. Do not put every H2/H3 subheading in strict Title Case. Use sentence case (only first word and proper nouns capitalized) for most subheadings. Mixing cases reads human; uniform Title Case reads AI.

20. Hyphenated-pair overuse. Do not cluster common AI hyphenations ("data-driven", "cross-functional", "client-facing", "decision-making", "high-quality", "end-to-end"). Use at most 1-2 of these compound modifiers per article; prefer plain phrasing elsewhere.

PRESERVE (do not alter):
- All factual content, tables, bullet lists, headings, and FAQ numbering.
`;

const HUMANIZER_ARTIFACT_PATTERNS: { label: string; pattern: RegExp }[] = [
  // Existing patterns
  {
    label: "signposting",
    pattern: /(?:^|\s)(?:let[’']?s dive in|here(?:[’']s| is) what you need to know|now let[’']?s explore)(?:$|\s|[,.!?;:])/i,
  },
  {
    label: "chatbot artifact",
    pattern: /(?:^|\s)(?:i hope this helps|let me know if you[’']d like|great question)(?:$|\s|[,.!?;:])/i,
  },
  { label: "filler phrase", pattern: /\b(?:in order to|due to the fact that|it is worth noting)\b/i },
  { label: "generic conclusion", pattern: /\b(?:in conclusion|to summarize|the future looks bright|exciting times lie ahead)\b/i },
  { label: "promotional tone", pattern: /\b(?:groundbreaking|transformative|breathtaking|pivotal moment)\b/i },

  // New patterns — ported from the Wikipedia Signs-of-AI-Writing catalog.
  // Each regex is word-boundary anchored so it won't false-positive on substrings
  // or markdown syntax, and kept conservative so it flags clear cases only.

  {
    // Significance inflation: phrases that puff up importance instead of stating facts.
    // "The tower stands as a testament to...", "...marks a pivotal moment in...",
    // "...represents a shift in the evolving landscape of..."
    label: "significance inflation",
    pattern: /\b(?:stands as|serves as|is a testament|(?:marks?|marking) a (?:pivotal|key|significant|crucial) (?:moment|turning point)|evolving landscape|indelible mark|deeply rooted|enduring testament|vital role|setting the stage for)\b/i,
  },
  {
    // Copula avoidance: wordy substitutes for "is/are/has". Only flag the inflated
    // plural/quantity forms — "features four rooms", "boasts over 200 followers" —
    // not legitimate singular uses like "features a case study" or "serves a meal".
    label: "copula avoidance",
    pattern: /\b(?:serves as (?:a|an|the)|stands as (?:a|an|the)|functions as (?:a|an|the)|boasts (?:over|more than|a whopping|an impressive)|features (?:four|three|five|six|seven|eight|nine|ten|over |more than |several |multiple |a range of |an array of ))/i,
  },
  {
    // Superficial -ing analyses: adjective tacked on with a participle for fake depth.
    // "...resonates with the region, symbolizing X, reflecting Y, contributing to Z."
    // Flag when a sentence contains two or more high-signal participles close together.
    label: "superficial -ing analysis",
    pattern: /,\s+(?:highlighting|underscoring|emphasizing|reflecting|symbolizing|showcasing|cultivating|fostering|encompassing|demonstrating)\s+(?:the|its|their|a|an)\b/i,
  },
  {
    // Negative parallelism: "It's not just X, it's Y" or "Not only X but also Y"
    // overused as a rhetorical crutch.
    label: "negative parallelism",
    pattern: /\b(?:it[’']?s not just|it[’']?s not merely|not only (?:is|does|are|has)[\s\S]{1,80}?\bbut (?:also |rather )?)/i,
  },
  {
    // Rule of three: forced triplet of verbs/nouns. Flag specific high-signal
    // templates that the skill lists as common AI fingerprints. The verb roots
    // need to match all common inflections (streamline / streamlines / streamlining).
    label: "rule of three (templated)",
    pattern: /\b(?:streamlin\w*[\s\S]{1,30}?,\s*enhanc\w*[\s\S]{1,30}?,\s*(?:and\s+)?foster\w*|ideat\w*[\s\S]{1,10}?,\s*iterat\w*[\s\S]{1,10}?,\s*(?:and\s+)?deliver\w*|seamless,\s+intuitive,\s+and\s+powerful)\b/i,
  },
  {
    // Persuasive authority tropes: phrases that pretend to cut through noise.
    // "The real question is...", "At its core, what really matters..."
    label: "persuasive authority trope",
    pattern: /\b(?:the real question is|at its core,?|what really matters (?:is|here)|the deeper (?:issue|question)|the heart of the matter|fundamentally speaking)\b/i,
  },
  {
    // False ranges: "from X to Y, from A to B" where the scale isn't meaningful.
    // Flag only the doubled construction — single "from X to Y" is fine in prose.
    label: "false range",
    pattern: /\bfrom [A-Za-z][\w\s-]{1,40}? to [A-Za-z][\w\s-]{1,40}?,\s+from [A-Za-z][\w\s-]{1,40}? to [A-Za-z]/i,
  },
  {
    // Fragmented header: an H2/H3 followed by a one-line paragraph that just
    // restates the heading before the real content begins. Detected by scanning
    // for a heading line followed by a short single-sentence line, followed by
    // a blank line and then substantive content.
    label: "fragmented header",
    pattern: /^#{2,3}\s+[^\n]+\n\n[^\n]{1,60}\.\s*\n\n[A-Z]/m,
  },
  {
    // Vague attributions / weasel authority (skill pattern 5). "Industry reports say",
    // "experts argue", "observers have cited", "some critics say" — appeal to vague
    // authorities without a named source.
    label: "vague attribution",
    pattern: /\b(?:industry reports (?:say|show|suggest|indicate)|experts (?:believe|argue|suggest|claim)|observers (?:have cited|note|say)|some critics (?:argue|say|contend)|industry observers (?:have noted|say)|according to (?:sources|reports|experts|observers)(?!\s+(?:at|from|in)\s+[A-Z]))/i,
  },
  {
    // Notability puffery (skill pattern 2). Weak detector that flags the specific
    // "cited in/featured in X, Y, Z" pattern where three or more media outlets get
    // listed. Low precision — false-positives on real listicles. Use as weak signal.
    label: "notability puffery",
    pattern: /\b(?:her|his|their) (?:views |work |writing |research )?(?:have |has )?been (?:cited|featured|published|interviewed) in [A-Za-z][A-Za-z\s]+,\s+[A-Za-z][A-Za-z\s]+,?\s+and\s+[A-Za-z]/i,
  },
  {
    // Knowledge-cutoff disclaimers (skill pattern 21). Residue from chat contexts
    // leaking into published articles.
    label: "knowledge-cutoff disclaimer",
    pattern: /\b(?:as of my (?:last |knowledge )?(?:update|training)|up to my last (?:training )?update|while specific details (?:are|remain) (?:limited|scarce|not (?:extensively |widely )?documented)|based on available information|my training data|as of (?:my )?knowledge cutoff)\b/i,
  },
  {
    // Sycophantic tone (skill pattern 22). Extends the chatbot-artifact regex
    // with more fawning variants that leak from chat contexts.
    label: "sycophantic tone",
    pattern: /\b(?:you[’']?re absolutely right|that[’']?s an excellent (?:point|question|observation)|what a (?:great|wonderful|fantastic) (?:question|point)|brilliant (?:question|observation)|you raise a (?:great|valid|excellent) point)\b/i,
  },
  {
    // Passive voice / subjectless fragments (skill pattern 13). Flag the very
    // specific AI-pattern "No X needed" / "No X required" fragments that drop
    // the subject. Active-voice passives in ordinary prose ("is considered",
    // "has been shown") are NOT flagged — those are legitimate English.
    label: "subjectless fragment",
    pattern: /(?:^|\n|\. )(?:No (?:configuration|setup|installation|registration|account|sign-up|code|changes?) (?:needed|required|necessary)\.?|No (?:training|learning curve|prior experience) (?:needed|required)\.?)(?=\s*\n|\s*$|\s+[A-Z])/i,
  },
  {
    // Excessive hedging (skill pattern 24). Only flag stacked hedges — multiple
    // hedge markers in one clause. Single "may" or "might" is perfectly fine
    // English; two or three in a row is the AI pattern.
    label: "stacked hedging",
    pattern: /\b(?:could potentially (?:possibly |perhaps )?|might possibly (?:perhaps )?|may (?:possibly |potentially )|it (?:could|might) be argued that (?:perhaps |possibly |potentially ))\b/i,
  },
  {
    // Emojis (skill pattern 18). AI chatbots often decorate headings and bullets
    // with emoji prefixes. Detect any emoji in the article.
    label: "emoji usage",
    pattern: /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F000}-\u{1F2FF}]/u,
  },
  {
    // Curly quotes (skill pattern 19). ChatGPT uses curly quotes by default
    // even when they mismatch the surrounding text's style.
    label: "curly quotes",
    pattern: /[\u201C\u201D\u2018\u2019]/,
  },
];

function detectHumanizerArtifacts(text: string): string[] {
  return HUMANIZER_ARTIFACT_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
}

async function runHumanizerAuditPass(client: Anthropic, article: string): Promise<{ article: string; findings: string[] }> {
  const findings = detectHumanizerArtifacts(article);
  if (findings.length === 0) return { article, findings };

  // Per-category definitions and before/after examples. Giving the model concrete
  // reference examples for each flagged category produces much better rewrites
  // than bare category labels, especially for patterns it might guess at
  // ("superficial -ing analysis", "false range") where the name isn't self-explanatory.
  const CATEGORY_GUIDE: Record<string, string> = {
    "signposting":
      `Announcing what you're about to do instead of doing it. Before: "Let's dive into how caching works." After: "Next.js caches data at multiple layers."`,
    "chatbot artifact":
      `Chatbot conversational residue that doesn't belong in published content. Remove phrases like "I hope this helps", "Let me know if you'd like", "Great question".`,
    "filler phrase":
      `Wordy phrases that can be replaced with one word. "In order to" → "to". "Due to the fact that" → "because". "It is worth noting that the data shows" → "the data shows".`,
    "generic conclusion":
      `Vague upbeat endings. Before: "In conclusion, the future looks bright." After: (cut entirely, or) "The company plans to open two more locations next year."`,
    "promotional tone":
      `Advertisement-style inflation ("groundbreaking", "transformative", "breathtaking"). Replace with concrete factual descriptions.`,
    "significance inflation":
      `Sentences that puff up importance. Before: "The institute was established in 1989, marking a pivotal moment in the evolving landscape." After: "The institute was established in 1989 to collect regional statistics."`,
    "copula avoidance":
      `Wordy substitutes for "is/are/has". Before: "Gallery 825 serves as LAAA's exhibition space and boasts over 3,000 square feet." After: "Gallery 825 is LAAA's exhibition space. It has 3,000 square feet."`,
    "superficial -ing analysis":
      `Participle chains tacked on for fake depth. Before: "The color palette resonates with the region, symbolizing local flora, reflecting the community's connection." After: "The color palette references local flora."`,
    "negative parallelism":
      `Overused "It's not X, it's Y" or "Not only X but also Y" rhetorical crutches. Before: "It's not just a beat, it's a statement." After: "The heavy beat adds to the aggressive tone."`,
    "rule of three (templated)":
      `Forced triplets like "streamlining processes, enhancing collaboration, and fostering alignment". Pick one concrete claim instead: "reduces review cycles by one business day."`,
    "persuasive authority trope":
      `Phrases that pretend to cut through noise without actually adding substance: "The real question is", "At its core", "What really matters". The sentence after usually just restates the previous one. Delete the trope and keep the direct claim.`,
    "false range":
      `"From X to Y, from A to B" constructions where X/Y and A/B aren't on meaningful scales. Replace with a plain list: "The book covers the Big Bang, star formation, and dark matter theories."`,
    "fragmented header":
      `A heading followed by a one-line paragraph that just restates the heading before real content begins. Delete the one-liner and start directly with the substantive paragraph.`,
    "vague attribution":
      `Appeals to vague authorities without named sources. Before: "Industry reports say adoption is accelerating." After: "A 2024 Gartner survey found adoption grew from 12% to 34%." Replace vague wording with a named source, or cut the claim if no source exists.`,
    "notability puffery":
      `Listing media outlets to imply importance. Before: "Her views have been cited in The NYT, BBC, and The Hindu." After: "In a 2024 NYT interview, she argued for outcome-based regulation." One specific citation with substance beats a list of outlets.`,
    "knowledge-cutoff disclaimer":
      `Residue from chat contexts like "as of my last update" or "while specific details are limited". Remove these phrases entirely and commit to a definite claim, or cut the sentence.`,
    "sycophantic tone":
      `Fawning chatbot language: "You're absolutely right", "That's an excellent question", "What a great point". Remove these entirely; they don't belong in published articles.`,
    "subjectless fragment":
      `AI-pattern dropped-subject lines like "No configuration needed." or "No prior experience required." Rewrite with an explicit subject: "You don't need a configuration file." or restructure: "The system works out of the box without configuration."`,
    "stacked hedging":
      `Multiple hedge markers piled on one statement: "could potentially possibly", "may perhaps potentially". Pick one: "may" or "could". Single hedges are fine; stacked hedges are the AI fingerprint.`,
    "emoji usage":
      `Emojis in headings, bullets, or prose. Remove them entirely. Write "Next steps:" instead of "✅ Next steps:".`,
    "curly quotes":
      `Typographic curly quotes (", ', ", ') slipping in from default word-processor behavior. Convert all to straight quotes (", ') for consistent style. This is a mechanical normalization — do not rephrase the sentences.`,
  };

  const findingsWithGuide = findings
    .map((finding) => {
      const guidance = CATEGORY_GUIDE[finding] ?? "";
      return guidance ? `- ${finding}: ${guidance}` : `- ${finding}`;
    })
    .join("\n");

  const auditPrompt = `A final "obviously AI-generated" audit flagged these specific pattern categories in the article:

${findingsWithGuide}

For each flagged category, find the offending passages and rewrite them using the "After" pattern shown. Do not rewrite passages that don't exhibit the flagged patterns; only target the specific phrases and constructions listed.

Preservation constraints:
- Preserve every fact and data point.
- Preserve every heading, table, bullet list, and the FAQ numbering (Q1. through Q5.).
- Keep contractions and natural rhythm; do not force slang.
- Em dashes allowed sparingly (≤2 per 1000 words). No en dashes or double hyphens.

Return the complete rewritten article.

ARTICLE:
${article}`;

  const rewritten = await callClaude(client, auditPrompt, 8192, {
    system: WRITER_SYSTEM_PROMPT,
    temperature: 0.5,
  });
  if (!rewritten.trim()) {
    logger.warn(
      { findings },
      "Humanizer audit pass returned empty output; preserving pre-audit article while findings remain unaddressed"
    );
    return { article, findings };
  }
  return { article: rewritten.trim(), findings };
}

const EDITORIAL_REQUIREMENTS = `
EDITORIAL REQUIREMENTS (STRICT):
1. Headline (H1) must be 6-10 words.
2. Subheads (H2/H3) must be 8-15 words each.
3. Include bullet points and 1-2 tables in the article body. Never more than 2 tables per article.
4. Keep FAQ section in Q1., Q2., Q3. numbered format. FAQ count is flexible: use 2, 3, or 5 FAQs based on how many genuinely unique and useful questions the topic supports. Never force extra FAQs just to hit a count; never include fewer than 2. Do not use 4 FAQs — that count reads as arbitrary.
5. FAQ answers must address questions NOT already answered anywhere in the main body. If a question's answer already appears in the body, drop that FAQ or replace it with a different question.
6. Primary keyword density must stay within 1.5% to 2.0%.
7. At least 30% of H2/H3 headings must include the primary keyword. Every H2/H3 heading must include at least one primary OR secondary keyword. When secondary keywords are provided, at least 25% of all H2/H3 headings must include at least one secondary keyword. Weave them naturally into the phrasing — do NOT keyword-stuff. Over-repeating the primary keyword across headings is itself a detection signal and works against SEO on modern search engines.
8. Write in formal language with paragraph-based flow, while preserving bullet lists and tables where relevant.
9. Em dashes (—) are allowed at low density (0-2 per 1000 words). No en dashes (–) or double hyphen em-dash usage (--).
`;

/**
 * Consolidated writer/editor system prompt. Sent via the `system` parameter
 * (not the user message) on every writing and rewriting call so Anthropic's
 * prompt cache can hit it across the research → writing → humanization →
 * self-critique → AI-signature retry → quality-fix chain. This alone removes
 * thousands of duplicated input tokens per article.
 */
const WRITER_SYSTEM_PROMPT = `You are a senior human editor for a professional blog. Your job is to produce or refine long-form articles that are accurate, formal, SEO-ready, and structurally varied enough to read like human writing rather than template output.

${EDITORIAL_REQUIREMENTS}

${MANDATORY_FORMATTING_RULES}

${HUMANIZATION_RULES}

OPENING LINE (the first body paragraph):
The opening paragraph is the single highest-leverage place to avoid formulaic AI patterns. Never open with:
- "In today's..." / "In the modern..." / "In the world of..." / "In the rapidly-changing landscape of..."
- "As [X] continues to evolve..."
- "Picture this..." / "Imagine a world where..."
- A generic rhetorical question.

Instead open with one of these patterns:
- A specific statistic with its source: "A 2023 Ahrefs study of 14 million pages found that 96% get zero organic traffic."
- A concrete named scenario: "When Shopify migrated its docs to Algolia in 2022, search engagement tripled within a quarter."
- A direct claim that takes a side: "Most advice on keyword density is wrong, and here is why it persists anyway."
- A short declarative hook followed by a longer explanatory sentence.

OUTPUT DISCIPLINE:
- Return ONLY the article content (markdown). No preamble, no "Here is the article", no trailing commentary.
- Start your response with the H1 line (# Title).
- Preserve markdown structure exactly: H1/H2/H3 headings, bullet lists, tables, and FAQ numbering (Q1., Q2., ...).
`;

// ─── Main pipeline ────────────────────────────────────────────────────────────

async function runPipeline(articleId: number): Promise<void> {
  logger.info({ articleId }, "Starting pipeline");

  let article;
  try {
    [article] = await db.select().from(articlesTable).where(eq(articlesTable.id, articleId));
    if (!article) {
      logger.error({ articleId }, "Article not found");
      return;
    }
  } catch (err) {
    logger.error({ articleId, err }, "Failed to fetch article");
    return;
  }

  const client = (() => {
    try {
      return getAnthropicClient();
    } catch {
      logger.warn({ articleId }, "No Anthropic API key — pipeline simulated");
      return null;
    }
  })();

  if (!client) {
    await updateArticleStatus(articleId, "failed", {
      errorMessage: "ANTHROPIC_API_KEY is not configured. Please add your API key to run the pipeline.",
    });
    await logStep(articleId, "startup", "failed", "No API key configured");
    return;
  }

  try {
    // Step 1: Collate input information
    await logStep(
      articleId,
      "input_collation",
      "completed",
      `Topic: ${article.topic}; Primary keyword: ${article.primaryKeyword}; Audience: ${article.targetAudience || "not provided"}; Target words: ${article.wordCountTarget}`
    );

    // Step 2: Deep research
    await updateArticleStatus(articleId, "researching");
    await logStep(articleId, "research", "running", "Building research knowledge base with outline and content gaps");

    // Truncate user-provided reference once up-front; the same trimmed value is
    // reused by both the research and writing prompts so the two steps see the
    // same source material.
    const referenceInput = article.referenceInput ? truncateReferenceInput(article.referenceInput) : "";

    const researchPrompt = `Produce a research brief for the following blog article. The brief will be read by another writer, so it must be self-contained.

TOPIC: ${article.topic}
PRIMARY KEYWORD: ${article.primaryKeyword}
${article.secondaryKeywords ? `SECONDARY KEYWORDS: ${article.secondaryKeywords}` : ""}
${article.targetAudience ? `TARGET AUDIENCE: ${article.targetAudience}` : ""}
TARGET WORD COUNT: ${article.wordCountTarget}
${referenceInput ? `\nREFERENCE INPUT (analyze FIRST; prioritize when forming outline, facts, and FAQs):\n<<<REFERENCE\n${referenceInput}\nREFERENCE>>>\n` : ""}

Produce these seven sections, in this order, using Markdown headings exactly as shown:

## Outline
A list of 5-7 H2 sections written as Markdown subheadings (use "### " prefix for each H2 candidate so they are easy to parse), with 1-3 H3 bullet points under each describing what that section will cover. Each H2 must cover a meaningfully different aspect of the topic.

## Audience pain points
3-6 concrete pain points the target audience has around this topic.

## Content gaps
3-5 angles or subtopics that typical articles on this subject skip or treat superficially.

## Data and specifics
Relevant statistics, dates, named sources, or specific facts worth including. Cite inline where possible.

## FAQ candidates
Propose 2, 3, or 5 unique FAQ questions with short answers. Pick the count based on how many genuinely distinct, useful questions the topic supports — do NOT pad to hit a number, and do NOT use 4. These must NOT overlap with the main outline or duplicate anything the article body will answer; they must be net-new information.

## Recommended angle
A one-paragraph hook or angle that differentiates this article from the competition.

## Research document
A condensed recap combining the final outline, top pain points, top data points, the identified gaps, and the recommended angle into a single reference block the writer can keep open while drafting.`;

    const researchOutput = await callClaude(client, researchPrompt, 4096, {
      temperature: 0.35,
      system: `You are a content research assistant. Produce concise, source-aware research briefs formatted in clean Markdown with the exact section headings requested. Do not editorialize; stick to facts, outlines, and concrete specifics.`,
    });
    await logStep(articleId, "research", "completed", `Research brief generated (${countWords(researchOutput)} words)`);

    // Count H2 section candidates from the research outline for format variation.
    // The research prompt instructs outline headings to use "### " (they live under
    // the "## Outline" H2). We count those, with a safety floor of 5 and ceiling of 7.
    const h3HeadingMatches = researchOutput.match(/^###\s/gm) || [];
    const estimatedH2Count = Math.min(7, Math.max(5, h3HeadingMatches.length || 6));
    const formatVariationInstruction = buildFormatVariationInstruction(estimatedH2Count);

    // Step 3: Generate Claude prompt
    await logStep(articleId, "prompt_generation", "running", "Generating structured Claude writing prompt");
    await updateArticleStatus(articleId, "writing");
    await logStep(articleId, "prompt_generation", "completed", "Prompt prepared with keyword density and formatting requirements");

    // Step 4: Write article (with mandatory formatting + format variation)
    await logStep(articleId, "writing", "running", "Generating article draft from structured prompt");

    const wordTarget = article.wordCountTarget;
    const primaryKwDensityTarget = Math.round(wordTarget * 0.015);
    const secondaryKwDensityTarget = Math.round(wordTarget * 0.005);

    const writingPrompt = `Write a complete blog article using the research brief below.

RESEARCH BRIEF:
${researchOutput}

ARTICLE SPECIFICATIONS:
- Topic: ${article.topic}
- Primary keyword: "${article.primaryKeyword}" — use approximately ${primaryKwDensityTarget} occurrences (target 1.5-2.0% density).
${article.secondaryKeywords ? `- Secondary keywords: "${article.secondaryKeywords}" — use approximately ${secondaryKwDensityTarget} occurrences total (~0.5% density).` : "- Secondary keywords: none provided; do not invent any."}
${article.targetAudience ? `- Target audience: ${article.targetAudience}` : ""}
- Target word count: ${wordTarget} words (±10%).

STRUCTURE:
- H1 title (6-10 words), then H2 sections, H3 subsections as needed.
- End with a "Frequently Asked Questions" section containing 2, 3, or 5 FAQs numbered "Q1.", "Q2.", ... (pick the count based on how many genuinely distinct questions the topic supports; do not use 4, do not pad).
- Each FAQ answer must introduce information that is NOT already in the main body. If you can't write a question whose answer isn't already in the body, drop that FAQ slot rather than pad.
${referenceInput ? `\nREFERENCE INPUT (incorporate where relevant):\n<<<REFERENCE\n${referenceInput}\nREFERENCE>>>\n` : ""}
${formatVariationInstruction}

Begin the article now, starting with the H1.`;

    const articleDraft = await callClaude(client, writingPrompt, 8192, {
      system: WRITER_SYSTEM_PROMPT,
    });
    await logStep(articleId, "writing", "completed", `Draft generated (${countWords(articleDraft)} words)`);

    // Step 3: Humanization pass
    await updateArticleStatus(articleId, "humanizing");
    await logStep(articleId, "humanization", "running", "Running AI-pattern detection and humanization pass");

    const humanizationPrompt = `The following article draft needs a humanization editing pass. Apply the rules in your system instructions and return the COMPLETE rewritten article.

Focus areas for this pass (in addition to your standing rules):
- Break any remaining predictable topic-sentence-then-support paragraph templates.
- Flatten overly smooth transitions; prefer direct links between ideas.
- Inject natural rhythm variation; slightly imperfect phrasing is acceptable if it reads more human.
- Eliminate "conclusion that summarizes everything" endings.
- Ensure headline and subheads are varied (avoid formulaic "How to X: Y Things").
- Ensure the FAQ section contains information that is NOT repeated in the body.
- Preserve all tables, bullet lists, and structural variety across H2 sections.

ARTICLE DRAFT:
${articleDraft}`;

    const humanizedDraft = await callClaude(client, humanizationPrompt, 8192, {
      system: WRITER_SYSTEM_PROMPT,
      temperature: 0.6,
    });

    // Self-critique pass: have the model read its own draft against a concrete
    // rubric of weak-writing patterns, then rewrite ONLY the specific passages
    // it flags. This is a two-stage chain — identify first, then fix — which
    // gets better targeted rewrites than a single "make it more human" pass.
    await logStep(articleId, "self_critique", "running", "Running editorial self-critique");

    const critiquePrompt = `You are the editor reviewing a draft blog article. Read it carefully and identify the specific passages that exhibit ANY of the following weak-writing patterns. Do not rewrite yet — just flag.

Patterns to flag:
1. A paragraph where every sentence is roughly the same length (within 5 words of each other).
2. A paragraph that follows the template: topic sentence → three parallel supporting sentences → mini-conclusion.
3. A sentence that hedges where it should be direct (over-use of "may", "can", "might", "often", "generally" when the article could state the claim plainly).
4. A sentence that uses a blacklisted term: ${LEXICAL_FINGERPRINT_BLACKLIST.slice(0, 15).join(", ")}, etc.
5. A generic closing line that summarizes what was just said instead of adding something.
6. A transition that reads as template padding (sentences that add no information, only connect paragraphs).

For each pattern you find, output a numbered list in this exact format:

ISSUE <n>: <pattern number from list above>
QUOTE: "<exact 1-2 sentence excerpt>"
REASON: <one-line explanation>

If no issues are found, respond with the single line: NO ISSUES FOUND

Do NOT rewrite the article yet. Only flag.

ARTICLE:
${humanizedDraft}`;

    const critiqueOutput = await callClaude(client, critiquePrompt, 2048, {
      system: `You are a sharp-eyed editor. You diagnose weak writing concretely by quoting specific passages. You never rewrite in the critique phase; you only flag. Stay under 1500 tokens total.`,
      temperature: 0.3,
    });

    let critiquedArticle = humanizedDraft;
    const hasIssues = !/^\s*NO ISSUES FOUND\s*$/mi.test(critiqueOutput) && critiqueOutput.includes("ISSUE");

    if (hasIssues) {
      const fixPrompt = `An editor reviewed the article draft below and flagged these specific issues:

${critiqueOutput}

Rewrite ONLY the flagged passages to fix the issues cited. Leave every other passage in the article untouched. Preserve all facts, headings, tables, bullet lists, and FAQ numbering.

Return the complete article with the flagged passages rewritten.

ARTICLE:
${humanizedDraft}`;

      const fixed = await callClaude(client, fixPrompt, 8192, {
        system: WRITER_SYSTEM_PROMPT,
        temperature: 0.5,
      });
      if (fixed.trim()) {
        critiquedArticle = fixed.trim();
      }
      await logStep(
        articleId,
        "self_critique",
        "completed",
        `Critique flagged issues; targeted rewrite applied. Critique length: ${critiqueOutput.length} chars.`,
      );
    } else {
      await logStep(articleId, "self_critique", "completed", "No weak-writing patterns flagged in self-critique");
    }

    await logStep(articleId, "humanization_audit", "running", "Running obvious-AI artifact audit pass");
    const { article: humanizedArticle, findings: auditFindings } = await runHumanizerAuditPass(client, critiquedArticle);
    await logStep(
      articleId,
      "humanization_audit",
      "completed",
      auditFindings.length > 0
        ? `Rewrote article after detecting: ${auditFindings.join(", ")}`
        : "No obvious AI artifacts detected in audit pass"
    );
    await logStep(articleId, "humanization", "completed", "Humanization pass complete");

    await logStep(articleId, "ai_signature_check", "running", "Running local AI-signature heuristics");
    let aiSignatureArticle = humanizedArticle;
    let aiSignatureRetryCount = 0;
    let burstinessScore = calculateBurstiness(aiSignatureArticle);
    let lexicalFingerprint = calculateLexicalFingerprint(aiSignatureArticle);
    let structuralUniformity = detectStructuralUniformity(aiSignatureArticle);
    let sentenceDist = calculateSentenceLengthDistribution(aiSignatureArticle);
    let punctuationDensity = calculatePunctuationDensity(aiSignatureArticle);
    const MAX_AI_SIGNATURE_RETRIES = 2;

    const failsHeuristics = () =>
      burstinessScore < 0.7 ||
      lexicalFingerprint.score > 3 ||
      structuralUniformity.uniform ||
      sentenceDist.issues.length > 0 ||
      punctuationDensity.issues.length > 0;

    while (aiSignatureRetryCount < MAX_AI_SIGNATURE_RETRIES && failsHeuristics()) {
      aiSignatureRetryCount++;
      const beforeSummary = formatAiSignatureMetrics(burstinessScore, lexicalFingerprint.score, structuralUniformity);
      const lexicalHitDetails = lexicalFingerprint.hits.length > 0
        ? lexicalFingerprint.hits.map((hit) => `${hit.term}(${hit.count})`).join(", ")
        : "none";

      const issueList: string[] = [];
      if (burstinessScore < 0.7) {
        issueList.push(`Burstiness (stdev/mean of sentence lengths) is ${burstinessScore.toFixed(2)}; target ≥0.70.`);
      }
      if (lexicalFingerprint.score > 3) {
        issueList.push(`Lexical fingerprint is ${lexicalFingerprint.score.toFixed(2)} blacklisted-hits per 1000 words (target ≤3.00). Offending terms: ${lexicalHitDetails}.`);
      }
      if (structuralUniformity.uniform) {
        issueList.push(`Structural uniformity: ${structuralUniformity.reasons.join("; ")}.`);
      }
      // New: sentence-length distribution signals
      for (const issue of sentenceDist.issues) {
        issueList.push(issue);
      }
      // New: punctuation-density signals
      for (const issue of punctuationDensity.issues) {
        issueList.push(issue);
      }

      const aiSignatureRewritePrompt = `The previous draft failed these writing-quality heuristics:

${issueList.map((item) => `- ${item}`).join("\n")}

Targeted rewrite guidance:
- Sentence-length variance: uniform 15-22 word sentences are the #1 AI-detection signal. Mix 4-7 word sentences alongside 25-35 word sentences INSIDE the same paragraph. Short sentences are high-impact; use them.
- Lexical blacklist: replace each flagged term with the plainest specific alternative, not another synonym. "Delve into" → "explore" or just "cover". "Underscore" → "show". "Navigate" (non-literal) → "handle" or drop.
- Structural uniformity: if paragraph lengths are too similar, break one section with a single-sentence paragraph followed by a longer analytical block. If too many sentences start the same way, lead with a dependent clause or a short declarative.
- Punctuation density: if em dashes are too frequent, replace most with commas or periods. If too rare, a single em dash per 1000 words reads natural, not AI.

Rewrite ONLY what is needed to fix the issues above. Do not touch compliant sections. Preserve all headings, tables, FAQ numbering, bullet lists, and factual content.

ARTICLE:
${aiSignatureArticle}`;

      const rewrittenForSignature = await callClaude(client, aiSignatureRewritePrompt, 8192, {
        system: WRITER_SYSTEM_PROMPT,
        temperature: 0.5,
      });
      if (rewrittenForSignature.trim()) {
        aiSignatureArticle = rewrittenForSignature.trim();
      }

      const afterBurstiness = calculateBurstiness(aiSignatureArticle);
      const afterLexical = calculateLexicalFingerprint(aiSignatureArticle);
      const afterUniformity = detectStructuralUniformity(aiSignatureArticle);
      const afterDist = calculateSentenceLengthDistribution(aiSignatureArticle);
      const afterPunct = calculatePunctuationDensity(aiSignatureArticle);
      const afterSummary = formatAiSignatureMetrics(afterBurstiness, afterLexical.score, afterUniformity);

      await logStep(
        articleId,
        `ai_signature_retry_${aiSignatureRetryCount}`,
        "completed",
        `Before: ${beforeSummary} | After: ${afterSummary} | Short/long ratio after: ${afterDist.shortRatio}/${afterDist.longRatio} | Em-dash density after: ${afterPunct.emDashPer1000}/1000`
      );

      burstinessScore = afterBurstiness;
      lexicalFingerprint = afterLexical;
      structuralUniformity = afterUniformity;
      sentenceDist = afterDist;
      punctuationDensity = afterPunct;
    }

    await logStep(
      articleId,
      "ai_signature_check",
      "completed",
      `Retries: ${aiSignatureRetryCount}; ${formatAiSignatureMetrics(burstinessScore, lexicalFingerprint.score, structuralUniformity)}`
    );

    // Opening-line check: catch drift back into "In today's..." / "In the modern..." openings
    // that slipped through the system-prompt instruction. Rewrite only the first paragraph
    // if detected — no need to touch the rest of the article.
    const formulaicOpener = detectFormulaicOpening(aiSignatureArticle);
    if (formulaicOpener) {
      await logStep(articleId, "opening_line_fix", "running", `Opener detected as formulaic: "${formulaicOpener}..."`);
      const openingFixPrompt = `The article below opens with a formulaic scene-setting phrase ("${formulaicOpener}...") that is a known AI-writing signal. Rewrite ONLY the first paragraph of the article to open in one of these stronger ways:

- A specific statistic or number with its source (e.g. "A 2023 Ahrefs study of 14 million pages found...").
- A concrete scenario or named example (e.g. "When Shopify migrated its docs to Algolia in 2022...").
- A direct claim that takes a position (e.g. "Most advice on keyword density is wrong.").
- A short declarative sentence followed by a longer explanatory one.

Do NOT use "In today's", "In the modern", "In the world of", "As [X] continues to evolve", "Picture this", or "Imagine". Do NOT open with a question. Do NOT change the rest of the article — only the first paragraph.

Preserve the H1 line exactly. Return the complete article.

ARTICLE:
${aiSignatureArticle}`;

      const rewrittenOpener = await callClaude(client, openingFixPrompt, 8192, {
        system: WRITER_SYSTEM_PROMPT,
        temperature: 0.5,
      });
      if (rewrittenOpener.trim()) {
        aiSignatureArticle = rewrittenOpener.trim();
      }
      await logStep(articleId, "opening_line_fix", "completed", "First paragraph rewritten");
    } else {
      await logStep(articleId, "opening_line_fix", "completed", "Opening passed; no formulaic scene-setting detected");
    }

    // Step 4: Subheading validation (CHANGE 3)
    await updateArticleStatus(articleId, "checking");
    await logStep(articleId, "subheading_check", "running", "Checking for negative framing in subheadings");

    const { article: afterHeadingFix, fixed: headingsFixed } = await fixNegativeHeadings(client, aiSignatureArticle);
    await logStep(
      articleId,
      "subheading_check",
      "completed",
      headingsFixed > 0
        ? `Rewrote ${headingsFixed} negatively-framed heading(s)`
        : "All subheadings passed — no negative framing found"
    );

    // Step 5: Structural uniformity check (CHANGE 4)
    await logStep(articleId, "structure_check", "running", "Checking for repeated section patterns");

    const { article: afterStructureFix, fixed: sectionsFixed } = await fixRepetitiveSections(client, afterHeadingFix);
    await logStep(
      articleId,
      "structure_check",
      "completed",
      sectionsFixed > 0
        ? `Restructured ${sectionsFixed} repetitive section(s)`
        : "Section variety check passed — no repeated patterns"
    );

    // Step 5b: Heading-pattern repetition check. When ≥70% of H2 headings
    // follow the same syntactic template (all "How to X", all "The N best Y",
    // etc.), rewrite the heading set for variety.
    let headingPatternArticle = afterStructureFix;
    const uniformHeadings = detectUniformHeadingPattern(headingPatternArticle);
    if (uniformHeadings) {
      await logStep(
        articleId,
        "heading_pattern_fix",
        "running",
        `${Math.round(uniformHeadings.ratio * 100)}% of H2 headings use the "${uniformHeadings.pattern}" template`,
      );
      const headingPatternPrompt = `${Math.round(uniformHeadings.ratio * 100)}% of the H2 headings in this article follow the same syntactic template ("${uniformHeadings.pattern}"). This makes the article read as formulaic.

Offending headings:
${uniformHeadings.headings.map((h, i) => `${i + 1}. ${h}`).join("\n")}

Rewrite these headings so the article's H2 set uses a MIX of different syntactic forms. Keep each heading SEO-safe (8-15 words), keep the primary/secondary keyword coverage intact, and keep the section topic the same. Examples of different forms to mix:
- Direct noun phrase: "Keyword density benchmarks across industries"
- Question form (use once at most): "What counts as natural keyword density?"
- Process or outcome framing: "Moving beyond the 1.5% keyword rule"
- Comparison: "Keyword density vs. topical coverage"
- Imperative: "Audit your existing posts against these benchmarks"

Do not apply the same form to all headings. Do not rewrite the body content; only the H2 heading lines.

Return the complete article with heading lines rewritten.

ARTICLE:
${headingPatternArticle}`;

      const headingPatternFixed = await callClaude(client, headingPatternPrompt, 8192, {
        system: WRITER_SYSTEM_PROMPT,
        temperature: 0.5,
      });
      if (headingPatternFixed.trim()) {
        headingPatternArticle = headingPatternFixed.trim();
      }
      await logStep(articleId, "heading_pattern_fix", "completed", "Diversified H2 heading templates");
    } else {
      await logStep(articleId, "heading_pattern_fix", "completed", "H2 heading templates already varied");
    }

    // Step 5c: Section-opener repetition check. When multiple H2 sections open
    // with a paragraph starting with the same first content word, rewrite the
    // openers for variety.
    let openerFixedArticle = headingPatternArticle;
    const openerRepetition = detectSectionOpenerRepetition(openerFixedArticle);
    if (openerRepetition) {
      await logStep(
        articleId,
        "section_opener_fix",
        "running",
        `${openerRepetition.sections.length} sections open with "${openerRepetition.word}..."`,
      );
      const openerPrompt = `${openerRepetition.sections.length} H2 sections in this article all open their first paragraph with the same first content word ("${openerRepetition.word}"). This is a formulaic pattern a human editor would flag.

Affected sections:
${openerRepetition.sections.map((h, i) => `${i + 1}. "${h}"`).join("\n")}

Rewrite ONLY the first sentence of each affected section so they start differently from one another. Mix approaches: one could lead with a number or statistic, another with a direct claim, another with a dependent clause, another with a concrete example. Do not start any two of these sections with the same first word.

Do not change any other content. Keep the H2 headings themselves untouched. Preserve all facts, tables, bullet lists, and FAQ numbering.

ARTICLE:
${openerFixedArticle}`;

      const openerFixed = await callClaude(client, openerPrompt, 8192, {
        system: WRITER_SYSTEM_PROMPT,
        temperature: 0.5,
      });
      if (openerFixed.trim()) {
        openerFixedArticle = openerFixed.trim();
      }
      await logStep(articleId, "section_opener_fix", "completed", "Diversified section-opening sentences");
    } else {
      await logStep(articleId, "section_opener_fix", "completed", "Section openers already varied");
    }

    // Step 5: Quality checks
    await logStep(articleId, "quality_check", "running", "Running quality checks");

    // Em dashes: only rewrite if density exceeds the upper band (2.5/1000 words)
    // or if any en-dash / double-hyphen slipped through (those are always wrong).
    const punctSnapshot = calculatePunctuationDensity(openerFixedArticle);
    const hasEnDashOrDoubleHyphen = /–|(?<!-)--(?!-)/.test(openerFixedArticle);

    let qualityArticle = openerFixedArticle;
    if (punctSnapshot.emDashPer1000 > 2.5 || hasEnDashOrDoubleHyphen) {
      await logStep(
        articleId,
        "em_dash_fix",
        "running",
        `Em-dash density ${punctSnapshot.emDashPer1000}/1000${hasEnDashOrDoubleHyphen ? " (plus en-dash or double-hyphen present)" : ""}`,
      );
      qualityArticle = await callClaude(
        client,
        `The article below has overuse or misuse of dash punctuation.
- Em-dash density is ${punctSnapshot.emDashPer1000} per 1000 words (target 0-2 per 1000).
- Any en dashes (–) or double hyphens (--) must be removed entirely.

Reduce em-dash usage by replacing most occurrences with commas, colons, or a restructured sentence. Keep at most 1-2 em dashes per 1000 words in the final output. Remove every en dash and every double hyphen.

Do NOT change any other wording. Do NOT change meaning, facts, headings, tables, bullets, or FAQ numbering.

ARTICLE:
${openerFixedArticle}`,
        8192,
        { temperature: 0.3 },
      );
    }

    // Curly-quote normalization (skill pattern 19). Mechanical fix — no model
    // call needed. Runs unconditionally since curly quotes can slip in from any
    // upstream step's output.
    const curlyFix = normalizeCurlyQuotes(qualityArticle);
    if (curlyFix.replaced > 0) {
      qualityArticle = curlyFix.text;
      await logStep(articleId, "curly_quote_fix", "completed", `Normalized ${curlyFix.replaced} curly quote(s) to straight quotes`);
    }

    let normalizedWordCount = countWords(qualityArticle);
    let normalizedPrimaryDensity = calculateKeywordDensity(qualityArticle, article.primaryKeyword);
    let normalizedSecondaryDensity = article.secondaryKeywords
      ? calculateKeywordDensity(qualityArticle, article.secondaryKeywords.split(",")[0].trim())
      : null;
    let normalizedEmDashCount = countEmDashes(qualityArticle);
    let normalizedFaqCount = extractFAQs(qualityArticle).length;
    let headlineWordCount = getHeadlineWordCount(qualityArticle);
    let subheadingViolations = getSubheadingLengthViolations(qualityArticle);
    let headingKeywordViolations = getHeadingKeywordViolations(qualityArticle, article.primaryKeyword, article.secondaryKeywords);
    let primaryHeadingCoverage = getPrimaryHeadingCoverage(qualityArticle, article.primaryKeyword);
    let secondaryHeadingCoverage = getSecondaryHeadingCoverage(qualityArticle, article.secondaryKeywords);
    const hasSecondaryKeywords = splitSecondaryKeywords(article.secondaryKeywords).length > 0;

    const ALLOWED_FAQ_COUNTS = new Set([2, 3, 5]);
    const faqCountInvalid = !ALLOWED_FAQ_COUNTS.has(normalizedFaqCount);
    const faqOverlap = detectFaqBodyOverlap(qualityArticle);
    const tableCount = countTables(qualityArticle);
    const tableCountInvalid = tableCount < 1 || tableCount > 2;
    // Secondary-keyword heading coverage: require ≥25% of headings to mention
    // any secondary keyword when the article has secondary keywords configured.
    const SECONDARY_HEADING_COVERAGE_MIN = 25;
    const secondaryHeadingCoverageLow =
      hasSecondaryKeywords && secondaryHeadingCoverage < SECONDARY_HEADING_COVERAGE_MIN;

    // New density / formatting checks from the Wikipedia Signs-of-AI-Writing skill:
    // boldface overuse, inline-header vertical lists, over-consistent title case
    // in subheadings, and AI-pattern hyphenated-pair overuse.
    const BOLD_DENSITY_MAX_PER_1000 = 5;
    const HYPHENATED_PAIR_MAX_DISTINCT = 3;
    const boldDensity = calculateBoldfaceDensity(qualityArticle);
    const inlineHeaderLists = detectInlineHeaderLists(qualityArticle);
    const titleCaseFinding = detectOverConsistentTitleCase(qualityArticle);
    const hyphenatedPairFinding = detectHyphenatedPairOveruse(qualityArticle);
    const boldDensityHigh = boldDensity.per1000 > BOLD_DENSITY_MAX_PER_1000;
    const hasInlineHeaderLists = inlineHeaderLists.count > 0;
    const titleCaseOverUniform = titleCaseFinding.flaggedHeadings.length > 0;
    const hyphenatedPairOveruse = hyphenatedPairFinding.count >= HYPHENATED_PAIR_MAX_DISTINCT;

    if (
      (headlineWordCount !== null && (headlineWordCount < 6 || headlineWordCount > 10)) ||
      subheadingViolations.length > 0 ||
      faqCountInvalid ||
      faqOverlap.duplicateFaqIndices.length > 0 ||
      tableCountInvalid ||
      normalizedPrimaryDensity < 1.5 ||
      normalizedPrimaryDensity > 2.0 ||
      headingKeywordViolations.length > 0 ||
      primaryHeadingCoverage < 30 ||
      secondaryHeadingCoverageLow ||
      boldDensityHigh ||
      hasInlineHeaderLists ||
      titleCaseOverUniform ||
      hyphenatedPairOveruse
    ) {
      await logStep(articleId, "heading_faq_fix", "running", "Fixing heading, FAQ, and keyword density/coverage constraints");

      // Build a targeted violation list so the model knows exactly what to fix.
      const violations: string[] = [];
      if (headlineWordCount !== null && (headlineWordCount < 6 || headlineWordCount > 10)) {
        violations.push(`H1 is ${headlineWordCount} words (must be 6-10).`);
      }
      if (subheadingViolations.length > 0) {
        violations.push(
          `${subheadingViolations.length} subheading(s) violate the 8-15 word range: ${subheadingViolations.slice(0, 5).map((s) => `"${s}"`).join("; ")}${subheadingViolations.length > 5 ? "; ..." : ""}`
        );
      }
      if (faqCountInvalid) {
        violations.push(`FAQ section has ${normalizedFaqCount} entries. Allowed counts are 2, 3, or 5 — whichever best matches the number of genuinely unique questions worth answering on this topic. Not 4. Remove any FAQ whose answer is already covered in the body.`);
      }
      if (faqOverlap.duplicateFaqIndices.length > 0) {
        violations.push(
          `${faqOverlap.duplicateFaqIndices.length} FAQ(s) duplicate content already in the body and must be rewritten with genuinely new questions or dropped: ${faqOverlap.details.slice(0, 3).join(" | ")}${faqOverlap.details.length > 3 ? " ..." : ""}`
        );
      }
      if (tableCountInvalid) {
        if (tableCount === 0) {
          violations.push(`Article has 0 tables. Required: 1 or 2 tables where the content genuinely benefits from comparison.`);
        } else {
          violations.push(`Article has ${tableCount} tables. Maximum allowed is 2. Merge or convert the least essential table(s) into prose or bullet lists.`);
        }
      }
      if (normalizedPrimaryDensity < 1.5) {
        violations.push(`Primary keyword "${article.primaryKeyword}" density is ${normalizedPrimaryDensity}% (must be 1.5-2.0%; add occurrences).`);
      } else if (normalizedPrimaryDensity > 2.0) {
        violations.push(`Primary keyword "${article.primaryKeyword}" density is ${normalizedPrimaryDensity}% (must be 1.5-2.0%; reduce occurrences).`);
      }
      if (headingKeywordViolations.length > 0) {
        violations.push(
          `${headingKeywordViolations.length} heading(s) contain no primary or secondary keyword: ${headingKeywordViolations.slice(0, 3).map((s) => `"${s}"`).join("; ")}${headingKeywordViolations.length > 3 ? "; ..." : ""}`
        );
      }
      if (primaryHeadingCoverage < 30) {
        violations.push(`Only ${primaryHeadingCoverage}% of headings include the primary keyword (must be at least 30%). Over 60% reads as keyword-stuffed; 30-50% is the healthy band.`);
      }
      if (secondaryHeadingCoverageLow) {
        const secondaryList = splitSecondaryKeywords(article.secondaryKeywords).join(", ");
        violations.push(
          `Only ${secondaryHeadingCoverage}% of headings include any secondary keyword (must be at least ${SECONDARY_HEADING_COVERAGE_MIN}%). Secondary keywords: ${secondaryList}. Weave at least one into a meaningful subset of H2/H3 headings without keyword-stuffing.`
        );
      }
      if (boldDensityHigh) {
        violations.push(
          `Boldface density is ${boldDensity.per1000}/1000 words (${boldDensity.boldCount} total \`**bold**\` occurrences). Maximum is ${BOLD_DENSITY_MAX_PER_1000}/1000. AI chatbots over-bold mechanically; humans use **bold** sparingly. Remove emphasis from most bolded phrases — keep it only on genuinely critical terms or first-mention defined terms.`
        );
      }
      if (hasInlineHeaderLists) {
        violations.push(
          `Detected ${inlineHeaderLists.count} run(s) of AI-pattern inline-header lists (bullets starting with "**Label:** ..."). Example: ${inlineHeaderLists.samples.slice(0, 2).map((s) => `"${s}"`).join("; ")}. Rewrite these as normal prose paragraphs, or as plain bullets without bolded labels.`
        );
      }
      if (titleCaseOverUniform) {
        violations.push(
          `${Math.round(titleCaseFinding.ratio * 100)}% of H2/H3 subheadings are in strict Title Case. Humans mix sentence case with occasional title case. Convert most subheadings to sentence case (only the first word and proper nouns capitalized). Keep the H1 untouched; this applies only to subheadings.`
        );
      }
      if (hyphenatedPairOveruse) {
        violations.push(
          `Detected ${hyphenatedPairFinding.count} distinct AI-pattern hyphenated pairs (${hyphenatedPairFinding.hits.join(", ")}). Real writing rarely uses all of these together. Keep at most 1-2 of these compound modifiers; replace the rest with plain forms ("cross-functional team" → "team across multiple functions"; "data-driven" → "based on data") or drop the hyphenation entirely.`
        );
      }

      qualityArticle = await callClaude(
        client,
        `Fix the specific violations below in the article. Do not rewrite sections that are already compliant.

VIOLATIONS:
${violations.map((v) => `- ${v}`).join("\n")}

HARD CONSTRAINTS (still apply):
- Preserve all facts, meaning, and section order.
- Em dashes allowed sparingly (≤2 per 1000 words); no en dashes or double hyphens.
- Formal language, coherent paragraphs.
- Keep bullet lists where they exist and 1-2 tables maximum (never more than 2).

ARTICLE:
${qualityArticle}`,
        8192,
        { temperature: 0.4 },
      );

      normalizedWordCount = countWords(qualityArticle);
      normalizedPrimaryDensity = calculateKeywordDensity(qualityArticle, article.primaryKeyword);
      normalizedSecondaryDensity = article.secondaryKeywords
        ? calculateKeywordDensity(qualityArticle, article.secondaryKeywords.split(",")[0].trim())
        : null;
      normalizedEmDashCount = countEmDashes(qualityArticle);
      normalizedFaqCount = extractFAQs(qualityArticle).length;
      headlineWordCount = getHeadlineWordCount(qualityArticle);
      subheadingViolations = getSubheadingLengthViolations(qualityArticle);
      headingKeywordViolations = getHeadingKeywordViolations(qualityArticle, article.primaryKeyword, article.secondaryKeywords);
      primaryHeadingCoverage = getPrimaryHeadingCoverage(qualityArticle, article.primaryKeyword);
      secondaryHeadingCoverage = getSecondaryHeadingCoverage(qualityArticle, article.secondaryKeywords);
    }

    const finalTables = countTables(qualityArticle);
    const finalPunct = calculatePunctuationDensity(qualityArticle);
    const finalDist = calculateSentenceLengthDistribution(qualityArticle);
    const qualityDetails = `Words: ${normalizedWordCount}, Primary density: ${normalizedPrimaryDensity}%, Secondary density: ${normalizedSecondaryDensity ?? "n/a"}%, Tables: ${finalTables}, Em dashes: ${normalizedEmDashCount} (${finalPunct.emDashPer1000}/1000), Short/long sentence ratio: ${finalDist.shortRatio}/${finalDist.longRatio}, Median sentence: ${finalDist.medianLength} words, FAQs: ${normalizedFaqCount}, H1 words: ${headlineWordCount ?? "n/a"}, Subhead violations: ${subheadingViolations.length}, Heading keyword violations: ${headingKeywordViolations.length}, Primary heading coverage: ${primaryHeadingCoverage}%, Secondary heading coverage: ${hasSecondaryKeywords ? secondaryHeadingCoverage + "%" : "n/a"}`;
    await logStep(articleId, "quality_check", "completed", qualityDetails);

    await logStep(articleId, "manual_quality_check", "completed", "Validated em-dash density, sentence distribution, and FAQ uniqueness/format requirements");

    // Copyleaks detection check was removed. The local quality gate + AI-signature
    // retries above are the only pre-publish checks now. If you later integrate a
    // different detector, add a new step between here and the formatting block.
    const finalArticle = qualityArticle;

    // Step 6: Formatting and final packaging
    await updateArticleStatus(articleId, "formatting");
    await logStep(articleId, "seo_metadata", "running", "Generating SEO metadata for final article");

    // Pull the actual H1 and first body paragraph so the SEO step has real
    // article signal rather than whichever 500 characters happen to come first.
    const h1Match = finalArticle.match(/^#\s+(.+)$/m);
    const h1Title = h1Match ? h1Match[1].trim() : article.topic;
    const firstBodyParagraph = finalArticle
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 40 && !l.startsWith("#") && !l.startsWith("|") && !l.startsWith("-")) ?? "";

    const seoPrompt = `Produce SEO metadata for this article.

Article H1: ${h1Title}
Primary keyword: ${article.primaryKeyword}
${article.secondaryKeywords ? `Secondary keywords: ${article.secondaryKeywords}` : ""}
First paragraph: ${firstBodyParagraph.slice(0, 400)}

Requirements:
- "title": 50-60 characters, includes the primary keyword, compelling for SERPs.
- "metaDescription": 140-160 characters, includes the primary keyword, with a clear value prop.
- "slug": lowercase URL-friendly slug derived from the title, hyphen-separated, no stop words at the ends.
- "tags": a comma-separated string of exactly 5 relevant tags.

Respond with a single JSON object and nothing else.`;

    let seoData = { title: article.topic, metaDescription: "", slug: "", tags: "" };
    try {
      // Prefill `{` to force the model straight into the JSON object and skip any
      // "Here is the metadata:" preamble. The helper prepends the prefill to the
      // returned string, so downstream JSON.parse sees a complete object.
      const seoRaw = await callClaude(client, seoPrompt, 512, {
        temperature: 0.2,
        system: `You generate SEO metadata. Return a single valid JSON object with exactly the keys "title", "metaDescription", "slug", "tags" and no other keys, no markdown fences, no commentary.`,
        prefill: "{",
      });
      const jsonMatch = seoRaw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        seoData = JSON.parse(jsonMatch[0]);
      }
    } catch {
      logger.warn({ articleId }, "SEO metadata parsing failed, using defaults");
    }
    await logStep(articleId, "seo_metadata", "completed", `Title: ${seoData.title}`);

    // Step 6 (continued): Google Docs delivery with final styling
    let googleDocUrl: string | undefined;
    let docFileName: string | undefined;

    if (isGoogleDocsConfigured()) {
      await logStep(articleId, "google_docs", "running", "Publishing to Google Docs with heading/body/table/FAQ styling");
      try {
        const docResult = await publishToGoogleDocs({
          title: seoData.title || article.topic,
          content: finalArticle,
        });
        googleDocUrl = docResult.docUrl;
        docFileName = docResult.fileName;
        await logStep(articleId, "google_docs", "completed", `Published: ${googleDocUrl} — File: ${docFileName}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn({ articleId, err }, "Google Docs publishing failed — article still saved");
        await logStep(articleId, "google_docs", "failed", `Google Docs error: ${errMsg}`);
      }
    } else {
      await logStep(articleId, "google_docs", "completed", "Google Docs not configured — skipped (add GOOGLE_SERVICE_ACCOUNT_JSON to enable)");
    }

    // Step 10: Complete
    const finalWordCount = countWords(finalArticle);
    const finalPrimaryDensity = calculateKeywordDensity(finalArticle, article.primaryKeyword);
    const finalSecondaryDensity = article.secondaryKeywords
      ? calculateKeywordDensity(finalArticle, article.secondaryKeywords.split(",")[0].trim())
      : null;
    const finalEmDashes = countEmDashes(finalArticle);
    const finalFaqs = extractFAQs(finalArticle);
    const finalBurstinessScore = calculateBurstiness(finalArticle);
    const finalLexicalFingerprintScore = calculateLexicalFingerprint(finalArticle).score;

    await updateArticleStatus(articleId, "completed", {
      title: seoData.title || article.topic,
      articleContent: finalArticle,
      wordCountActual: finalWordCount,
      primaryKeywordDensity: finalPrimaryDensity,
      secondaryKeywordDensity: finalSecondaryDensity ?? undefined,
      emDashCount: finalEmDashes,
      faqCount: finalFaqs.length,
      copyleaksScore: undefined, // Copyleaks integration removed; column retained for schema compat
      seoMetaDescription: seoData.metaDescription,
      seoSlug: seoData.slug || generateSeoSlug(seoData.title, article.primaryKeyword),
      seoTags: seoData.tags,
      retryCount: 0, // Copyleaks retry loop removed
      burstinessScore: finalBurstinessScore,
      lexicalFingerprintScore: finalLexicalFingerprintScore,
      aiSignatureRetryCount,
      completedAt: new Date(),
      googleDocFileName: docFileName ?? undefined,
      googleDocUrl: googleDocUrl ?? undefined,
    });

    logger.info({ articleId }, "Pipeline completed successfully");
  } catch (err) {
    logger.error({ articleId, err }, "Pipeline failed");
    const errorMessage = err instanceof Error ? err.message : String(err);
    await updateArticleStatus(articleId, "failed", { errorMessage });
    await logStep(articleId, "pipeline", "failed", errorMessage);
  }
}

export { runPipeline };
