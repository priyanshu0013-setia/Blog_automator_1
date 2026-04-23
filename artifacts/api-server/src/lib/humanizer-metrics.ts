export const LEXICAL_FINGERPRINT_BLACKLIST = [
  // Max Planck Institute verified overuse post-ChatGPT (+35% to +51%)
  "delve",
  "realm",
  "adept",
  // Classic RLHF-era AI vocabulary (high overuse)
  "tapestry",
  "multifaceted",
  "crucial",
  "underscore",
  "underscores",
  "underpins",
  "pivotal",
  "groundbreaking",
  "transformative",
  "seamless",
  "robust",
  "leverage",
  "harness",
  "navigate",
  "landscape",
  "ever-evolving",
  "nuanced",
  "testament",
  "bolster",
  "paradigm",
  "foster", // in non-literal "foster growth" sense
  // Promotional / travel-brochure vocabulary (skill pattern 4)
  "vibrant",
  "nestled",
  "must-visit",
  "stunning",
  "breathtaking",
  "in the heart of",
  "boasts a",
  "boasts an",
  // AI padding phrases
  "in the modern landscape",
  "in today's world",
  "in today's fast-paced",
  "it is important to note",
  "it is worth noting",
  "in conclusion",
  "navigate the complexities",
  "navigating the complexities",
  // Monotone additive transitions — real writers mix "but/also/and"
  "moreover",
  "furthermore",
  "additionally",
  "in addition",
  "what's more",
] as const;

type LexicalHit = { term: string; count: number };

const ARTICLE_STARTERS = new Set(["a", "an", "the"]);
const PRONOUN_STARTERS = new Set([
  "i", "you", "he", "she", "it", "we", "they",
  "this", "that", "these", "those", "who", "which", "someone", "anyone", "everyone",
]);
const CONJUNCTION_STARTERS = new Set([
  "and", "but", "or", "so", "yet", "for", "nor",
  "although", "because", "since", "while", "if", "when", "unless",
]);

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripMarkdownPreserveParagraphs(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/`[^`]*`/g, " ")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, "")
    .replace(/\r\n/g, "\n");
}

function getWords(text: string): string[] {
  return text
    .toLowerCase()
    .match(/[a-z0-9]+(?:[’'-][a-z0-9]+)*/g) ?? [];
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function countTerm(term: string, text: string): number {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const regex = new RegExp(`(?<!\\w)${escaped}(?!\\w)`, "gi");
  return text.match(regex)?.length ?? 0;
}

function classifySentenceStart(word: string): "article" | "pronoun" | "conjunction" | "other" {
  if (ARTICLE_STARTERS.has(word)) return "article";
  if (PRONOUN_STARTERS.has(word)) return "pronoun";
  if (CONJUNCTION_STARTERS.has(word)) return "conjunction";
  return "other";
}

export function calculateBurstiness(text: string): number {
  const cleaned = stripMarkdown(text);
  const sentenceLengths = splitSentences(cleaned)
    .map((sentence) => getWords(sentence).length)
    .filter((count) => count > 0);

  if (sentenceLengths.length === 0) return 0;

  const mean = sentenceLengths.reduce((sum, count) => sum + count, 0) / sentenceLengths.length;
  if (mean === 0) return 0;

  const variance = sentenceLengths.reduce((sum, count) => sum + Math.pow(count - mean, 2), 0) / sentenceLengths.length;
  const stdDev = Math.sqrt(variance);
  return Number((stdDev / mean).toFixed(4));
}

/**
 * Human blog writing produces actual short AND actual long sentences, not just
 * variance. ChatGPT-style prose tends to cluster sentences between 15 and 22
 * words, which can still pass a coefficient-of-variation check if two outliers
 * drag the stdev up. This measures the distribution shape directly.
 *
 * Returns the counts and flags whether the distribution looks AI-typical
 * (no real short sentences, no real long sentences, median in the AI band).
 */
export function calculateSentenceLengthDistribution(text: string): {
  totalSentences: number;
  shortSentences: number; // <=8 words
  longSentences: number; // >=25 words
  medianLength: number;
  shortRatio: number; // shortSentences / totalSentences
  longRatio: number;
  issues: string[];
} {
  const cleaned = stripMarkdown(text);
  const lengths = splitSentences(cleaned)
    .map((sentence) => getWords(sentence).length)
    .filter((count) => count > 0)
    .sort((a, b) => a - b);

  const total = lengths.length;
  if (total === 0) {
    return {
      totalSentences: 0,
      shortSentences: 0,
      longSentences: 0,
      medianLength: 0,
      shortRatio: 0,
      longRatio: 0,
      issues: [],
    };
  }

  const shortSentences = lengths.filter((l) => l <= 8).length;
  const longSentences = lengths.filter((l) => l >= 25).length;
  const shortRatio = shortSentences / total;
  const longRatio = longSentences / total;
  const median = total % 2 === 0
    ? (lengths[total / 2 - 1] + lengths[total / 2]) / 2
    : lengths[Math.floor(total / 2)];

  const issues: string[] = [];
  // Target bands based on typical human blog writing: 10-25% short, 10-20% long.
  if (shortRatio < 0.10) {
    issues.push(`Only ${(shortRatio * 100).toFixed(1)}% of sentences are ≤8 words (target ≥10%).`);
  }
  if (longRatio < 0.08) {
    issues.push(`Only ${(longRatio * 100).toFixed(1)}% of sentences are ≥25 words (target ≥8%).`);
  }
  // Median in 17-22 range is the classic AI cluster; human blog median is usually 13-18.
  if (median >= 17 && median <= 22 && shortRatio < 0.15) {
    issues.push(`Median sentence length is ${median} words (AI-typical range); add more short sentences to break the cluster.`);
  }

  return {
    totalSentences: total,
    shortSentences,
    longSentences,
    medianLength: Number(median.toFixed(1)),
    shortRatio: Number(shortRatio.toFixed(3)),
    longRatio: Number(longRatio.toFixed(3)),
    issues,
  };
}

/**
 * Check punctuation density against human-blog baselines. Both extremes are
 * detection signals: zero em dashes is itself an AI pattern (over-sanitized),
 * while dense em dashes are the classic AI over-reliance pattern. Semicolons
 * and colons have analogous bands.
 *
 * Returns counts per 1000 words plus a list of out-of-band issues.
 */
export function calculatePunctuationDensity(text: string): {
  wordCount: number;
  emDashPer1000: number;
  semicolonPer1000: number;
  colonPer1000: number;
  issues: string[];
} {
  const cleaned = stripMarkdownPreserveParagraphs(text);
  // Exclude markdown table separator rows before counting dashes.
  const withoutTableRows = cleaned
    .split("\n")
    .filter((line) => !/^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line))
    .join("\n");

  const words = getWords(withoutTableRows);
  const wordCount = words.length;
  if (wordCount === 0) {
    return { wordCount: 0, emDashPer1000: 0, semicolonPer1000: 0, colonPer1000: 0, issues: [] };
  }

  const emDashes = (withoutTableRows.match(/—|–|(?<!-)--(?!-)/g) ?? []).length;
  const semicolons = (withoutTableRows.match(/;/g) ?? []).length;
  // Exclude colons at end of heading lines or in lists ("Note:", "Example:").
  const bodyText = withoutTableRows
    .split("\n")
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    .join("\n");
  const colons = (bodyText.match(/:/g) ?? []).length;

  const per1000 = (n: number) => Number(((n / wordCount) * 1000).toFixed(2));
  const emDashPer1000 = per1000(emDashes);
  const semicolonPer1000 = per1000(semicolons);
  const colonPer1000 = per1000(colons);

  const issues: string[] = [];
  // Human blog baseline ranges (empirical, conservative):
  //   em dashes: 0.3 - 2.0 per 1000 words
  //   semicolons: 0 - 4 per 1000 words (optional)
  //   colons: 2 - 8 per 1000 words
  if (emDashPer1000 > 2.5) {
    issues.push(`Em dash density is ${emDashPer1000}/1000 words (typical human range 0.3-2.0); reduce.`);
  }
  if (colonPer1000 > 10) {
    issues.push(`Colon density is ${colonPer1000}/1000 words (typical human range 2-8); reduce.`);
  }
  if (semicolonPer1000 > 6) {
    issues.push(`Semicolon density is ${semicolonPer1000}/1000 words (typical human range 0-4); reduce.`);
  }

  return { wordCount, emDashPer1000, semicolonPer1000, colonPer1000, issues };
}

export function calculateLexicalFingerprint(text: string): { score: number; hits: LexicalHit[] } {
  const cleaned = stripMarkdown(text).toLowerCase();
  const wordCount = getWords(cleaned).length;
  const hits = LEXICAL_FINGERPRINT_BLACKLIST
    .map((term) => ({ term, count: countTerm(term, cleaned) }))
    .filter((hit) => hit.count > 0);
  const totalHits = hits.reduce((sum, hit) => sum + hit.count, 0);
  const score = wordCount > 0 ? Number(((totalHits / wordCount) * 1000).toFixed(2)) : 0;
  return { score, hits };
}

export function detectStructuralUniformity(text: string): { uniform: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const cleanedForParagraphs = stripMarkdownPreserveParagraphs(text);

  const paragraphs = cleanedForParagraphs
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\n/g, " ").replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0);

  const paragraphWordCounts = paragraphs.map((paragraph) => getWords(paragraph).length).filter((count) => count > 0);
  if (paragraphWordCounts.length > 0) {
    const meanParagraphWords = paragraphWordCounts.reduce((sum, count) => sum + count, 0) / paragraphWordCounts.length;
    const withinBand = paragraphWordCounts.filter(
      (count) => count >= meanParagraphWords * 0.8 && count <= meanParagraphWords * 1.2
    ).length;
    const ratio = withinBand / paragraphWordCounts.length;
    if (ratio > 0.6) {
      reasons.push("More than 60% of paragraphs have similar length (±20% of mean).");
    }
  }

  const sentences = splitSentences(stripMarkdown(text));
  let streak = 0;
  let previousCategory: "article" | "pronoun" | "conjunction" | "other" | null = null;
  for (const sentence of sentences) {
    const firstWord = sentence.match(/[A-Za-z]+(?:[’'-][A-Za-z]+)*/)?.[0]?.toLowerCase();
    if (!firstWord) {
      streak = 0;
      previousCategory = null;
      continue;
    }
    const category = classifySentenceStart(firstWord);
    if (category === "other") {
      streak = 0;
      previousCategory = null;
      continue;
    }

    if (category === previousCategory) {
      streak += 1;
    } else {
      streak = 1;
      previousCategory = category;
    }

    if (streak >= 3) {
      reasons.push("Three or more consecutive sentences start with the same first-word category.");
      break;
    }
  }

  const intro = stripMarkdown(text).trim().toLowerCase();
  if (/^(?:in today(?:'|\u2019)s|in the modern|as [^.!?]{0,80} continues to evolve)\b/.test(intro)) {
    reasons.push("Intro uses formulaic scene-setting framing.");
  }

  return {
    uniform: reasons.length > 0,
    reasons,
  };
}
