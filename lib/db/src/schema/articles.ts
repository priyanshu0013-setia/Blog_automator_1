import { pgTable, text, serial, timestamp, integer, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const articlesTable = pgTable("articles", {
  id: serial("id").primaryKey(),
  title: text("title"),
  topic: text("topic").notNull(),
  primaryKeyword: text("primary_keyword").notNull(),
  secondaryKeywords: text("secondary_keywords"),
  targetAudience: text("target_audience"),
  referenceInput: text("reference_input"),
  wordCountTarget: integer("word_count_target").notNull().default(1500),
  wordCountActual: integer("word_count_actual"),
  status: text("status").notNull().default("queued"),
  copyleaksScore: real("copyleaks_score"),
  burstinessScore: real("burstiness_score"),
  lexicalFingerprintScore: real("lexical_fingerprint_score"),
  primaryKeywordDensity: real("primary_keyword_density"),
  secondaryKeywordDensity: real("secondary_keyword_density"),
  emDashCount: integer("em_dash_count"),
  faqCount: integer("faq_count"),
  googleDocUrl: text("google_doc_url"),
  googleDocFileName: text("google_doc_file_name"),
  seoMetaDescription: text("seo_meta_description"),
  seoSlug: text("seo_slug"),
  seoTags: text("seo_tags"),
  retryCount: integer("retry_count").notNull().default(0),
  aiSignatureRetryCount: integer("ai_signature_retry_count").notNull().default(0),
  createdBy: text("created_by"),
  errorMessage: text("error_message"),
  articleContent: text("article_content"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const insertArticleSchema = createInsertSchema(articlesTable).omit({
  id: true,
  createdAt: true,
  completedAt: true,
});

export type InsertArticle = z.infer<typeof insertArticleSchema>;
export type Article = typeof articlesTable.$inferSelect;
