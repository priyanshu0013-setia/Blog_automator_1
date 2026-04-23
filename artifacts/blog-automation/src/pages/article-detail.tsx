import { useParams, useLocation } from "wouter";
import { useGetArticle, useGetArticleLogs, useDeleteArticle, useRetryArticle, getListArticlesQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { StatusBadge, AiSignatureRetryCount } from "@/components/shared";
import { ArrowLeft, RefreshCw, Trash2, Copy, CheckCircle, XCircle, AlertCircle, FileText } from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";

const TABLE_LINE_PATTERN = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR_CELL_PATTERN = /^:?-{3,}:?$/;

export default function ArticleDetail() {
  const { id } = useParams<{ id: string }>();
  const articleId = parseInt(id || "0", 10);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<"content" | "seo" | "logs">("content");
  const [copied, setCopied] = useState(false);

  const { data: article, isLoading, refetch } = useGetArticle(articleId, {
    query: {
      enabled: !!articleId,
      queryKey: [`/api/articles/${articleId}`],
      refetchInterval: 5000,
    },
  });

  const isActive = article ? !["completed", "failed", "flagged"].includes(article.status) : false;

  const { data: logs } = useGetArticleLogs(articleId, {
    query: {
      queryKey: [`/api/articles/${articleId}/logs`],
      refetchInterval: isActive ? 3000 : false,
    },
  });

  const deleteArticle = useDeleteArticle({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListArticlesQueryKey() });
        setLocation("/history");
        toast({ title: "Article deleted" });
      },
    },
  });

  const retryArticle = useRetryArticle({
    mutation: {
      onSuccess: () => {
        refetch();
        toast({ title: "Article queued for retry" });
      },
    },
  });

  const copyContent = () => {
    if (article?.articleContent) {
      navigator.clipboard.writeText(article.articleContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: "Copied to clipboard" });
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 bg-muted rounded animate-pulse" />
        <div className="h-64 bg-muted rounded-lg animate-pulse" />
      </div>
    );
  }

  if (!article) {
    return (
      <div className="text-center py-16">
        <p className="text-muted-foreground">Article not found.</p>
        <button onClick={() => setLocation("/history")} className="mt-3 text-primary hover:underline text-sm">
          Back to history
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <button
            onClick={() => setLocation("/history")}
            className="mt-1 p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h1 className="text-xl font-semibold text-foreground">
              {article.title || article.topic}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">{article.primaryKeyword}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StatusBadge status={article.status} />
          {isActive && (
            <button onClick={() => refetch()} className="p-2 rounded border border-border text-muted-foreground hover:text-foreground transition-colors">
              <RefreshCw className="h-4 w-4" />
            </button>
          )}
          {(article.status === "failed" || article.status === "flagged") && (
            <button
              data-testid="button-retry"
              onClick={() => retryArticle.mutate({ id: article.id })}
              className="inline-flex items-center gap-2 bg-amber-500 text-white px-3 py-2 rounded-md text-sm font-medium hover:bg-amber-600 transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </button>
          )}
          <button
            data-testid="button-delete"
            onClick={() => {
              if (confirm("Delete this article permanently?")) {
                deleteArticle.mutate({ id: article.id });
              }
            }}
            className="p-2 rounded border border-border text-muted-foreground hover:text-destructive hover:border-destructive/30 transition-colors"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Quality check scores */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <QualityCard
          label="AI-Signature Retries"
          good={article.aiSignatureRetryCount === 0}
          bad={article.aiSignatureRetryCount != null && article.aiSignatureRetryCount >= 2}
          value={<AiSignatureRetryCount count={article.aiSignatureRetryCount} />}
          sub="0 = passed first try"
        />
        <QualityCard
          label="Primary Keyword"
          good={article.primaryKeywordDensity != null && article.primaryKeywordDensity >= 1.5 && article.primaryKeywordDensity <= 2}
          bad={article.primaryKeywordDensity != null && (article.primaryKeywordDensity < 1.5 || article.primaryKeywordDensity > 2)}
          value={article.primaryKeywordDensity != null ? `${article.primaryKeywordDensity.toFixed(1)}%` : "—"}
          sub="Target: 1.5–2.0%"
        />
        <QualityCard
          label="Em Dashes"
          good={article.emDashCount != null && article.emDashCount <= 2}
          bad={article.emDashCount != null && article.emDashCount > 4}
          value={article.emDashCount != null ? String(article.emDashCount) : "—"}
          sub="Target: 0–2 per 1000 words"
        />
        <QualityCard
          label="FAQ Count"
          good={article.faqCount != null && [2, 3, 5].includes(article.faqCount)}
          bad={article.faqCount != null && ![2, 3, 5].includes(article.faqCount)}
          value={article.faqCount != null ? String(article.faqCount) : "—"}
          sub="Allowed: 2, 3, or 5"
        />
        <QualityCard
          label="Burstiness"
          good={article.burstinessScore != null && article.burstinessScore >= 0.7}
          bad={article.burstinessScore != null && article.burstinessScore < 0.5}
          value={article.burstinessScore != null ? article.burstinessScore.toFixed(2) : "—"}
          sub="Target: ≥ 0.70"
        />
        <QualityCard
          label="Lexical Fingerprint"
          good={article.lexicalFingerprintScore != null && article.lexicalFingerprintScore < 3}
          bad={article.lexicalFingerprintScore != null && article.lexicalFingerprintScore > 5}
          value={article.lexicalFingerprintScore != null ? article.lexicalFingerprintScore.toFixed(2) : "—"}
          sub="Target: < 3.00 per 1000"
        />
      </div>

      {/* Error message */}
      {article.errorMessage && (
        <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-lg p-4 flex gap-3">
          <AlertCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-red-800 dark:text-red-300">Pipeline Error</p>
            <p className="text-xs text-red-700 dark:text-red-400 mt-1 font-mono">{article.errorMessage}</p>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-border">
        <div className="flex gap-6">
          {(["content", "seo", "logs"] as const).map((tab) => (
            <button
              key={tab}
              data-testid={`tab-${tab}`}
              onClick={() => setActiveTab(tab)}
              className={`pb-3 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
                activeTab === tab
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab === "seo" ? "SEO Metadata" : tab}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "content" && (
        <div>
          {!article.articleContent ? (
            <div className="bg-muted rounded-lg p-10 text-center">
              <FileText className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
              {isActive ? (
                <p className="text-sm text-muted-foreground">Article is being generated...</p>
              ) : (
                <p className="text-sm text-muted-foreground">No article content available.</p>
              )}
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between mb-4">
                <div className="text-sm text-muted-foreground">
                  {article.wordCountActual != null && `${article.wordCountActual.toLocaleString()} words`}
                </div>
                <button
                  data-testid="button-copy"
                  onClick={copyContent}
                  className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  {copied ? <CheckCircle className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                  {copied ? "Copied" : "Copy content"}
                </button>
              </div>
              <div className="bg-card border border-card-border rounded-lg p-6">
                <ArticleRenderer content={article.articleContent} />
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === "seo" && (
        <div className="bg-card border border-card-border rounded-lg p-5 space-y-4">
          <MetaField label="Article Title" value={article.title} />
          <MetaField label="Meta Description" value={article.seoMetaDescription} />
          <MetaField label="URL Slug" value={article.seoSlug} mono />
          <MetaField label="Tags" value={article.seoTags} />
          {article.googleDocFileName && <MetaField label="Google Doc Name" value={article.googleDocFileName} mono />}
          {article.googleDocUrl && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Google Doc</p>
              <a href={article.googleDocUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline">
                Open document
              </a>
            </div>
          )}
        </div>
      )}

      {activeTab === "logs" && (
        <div className="bg-card border border-card-border rounded-lg overflow-hidden">
          {!logs || logs.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">No pipeline logs available yet.</div>
          ) : (
            <div className="divide-y divide-border">
              {logs.map((log) => (
                <div key={log.id} className="flex items-start gap-4 p-4">
                  <div className={`mt-1 h-2.5 w-2.5 rounded-full shrink-0 ${
                    log.status === "completed" ? "bg-green-500" :
                    log.status === "failed" ? "bg-red-500" : "bg-blue-500 animate-pulse"
                  }`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-sm font-medium text-foreground capitalize">
                        {log.stepName.replace(/_/g, " ")}
                      </p>
                      <span className={`text-xs font-medium shrink-0 ${
                        log.status === "completed" ? "text-green-600" :
                        log.status === "failed" ? "text-red-600" : "text-blue-600"
                      }`}>
                        {log.status}
                      </span>
                    </div>
                    {log.details && (
                      <p className="text-xs text-muted-foreground mt-0.5">{log.details}</p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">
                      {format(new Date(log.createdAt), "MMM d, h:mm:ss a")}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Meta info */}
      <div className="text-xs text-muted-foreground flex items-center gap-4 pt-2 border-t border-border">
        <span>Created {formatDistanceToNow(new Date(article.createdAt), { addSuffix: true })}</span>
        {article.completedAt && (
          <span>Completed {formatDistanceToNow(new Date(article.completedAt), { addSuffix: true })}</span>
        )}
        {article.createdBy && <span>By {article.createdBy}</span>}
        {article.aiSignatureRetryCount > 0 && <span>{article.aiSignatureRetryCount} AI-signature retr{article.aiSignatureRetryCount === 1 ? "y" : "ies"}</span>}
      </div>
    </div>
  );
}

function QualityCard({ label, value, sub, good, bad }: {
  label: string;
  value: React.ReactNode;
  sub: string;
  good: boolean;
  bad: boolean;
}) {
  return (
    <div className="bg-card border border-card-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        {good ? <CheckCircle className="h-4 w-4 text-green-500" /> :
         bad ? <XCircle className="h-4 w-4 text-red-500" /> :
         <div className="h-4 w-4" />}
      </div>
      <div className="text-lg font-bold text-foreground">{value}</div>
      <p className="text-xs text-muted-foreground mt-1">{sub}</p>
    </div>
  );
}

function MetaField({ label, value, mono = false }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">{label}</p>
      {value ? (
        <p className={`text-sm text-foreground ${mono ? "font-mono bg-muted px-2 py-1 rounded" : ""}`}>{value}</p>
      ) : (
        <p className="text-sm text-muted-foreground italic">Not generated yet</p>
      )}
    </div>
  );
}

function ArticleRenderer({ content }: { content: string }) {
  const lines = content.split("\n");
  const BULLET_LINE_PATTERN = /^\s*[-*]\s+/;
  const renderInline = (value: string, keyPrefix: string): React.ReactNode[] => {
    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    let idx = 0;

    while (cursor < value.length) {
      const open = value.indexOf("**", cursor);
      if (open === -1) {
        nodes.push(<span key={`${keyPrefix}-text-${idx++}`}>{value.slice(cursor)}</span>);
        break;
      }
      const close = value.indexOf("**", open + 2);
      if (close === -1) {
        nodes.push(<span key={`${keyPrefix}-text-${idx++}`}>{value.slice(cursor)}</span>);
        break;
      }
      if (open > cursor) {
        nodes.push(<span key={`${keyPrefix}-text-${idx++}`}>{value.slice(cursor, open)}</span>);
      }
      nodes.push(<strong key={`${keyPrefix}-bold-${idx++}`}>{value.slice(open + 2, close)}</strong>);
      cursor = close + 2;
    }

    if (nodes.length === 0) nodes.push(<span key={`${keyPrefix}-text-0`}>{value}</span>);
    return nodes;
  };
  const isTableLine = (line: string) => TABLE_LINE_PATTERN.test(line);
  const splitTableCells = (line: string) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
  const isSeparatorRow = (line: string) =>
    splitTableCells(line).every((cell) => TABLE_SEPARATOR_CELL_PATTERN.test(cell));

  const rendered: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("# ")) {
      rendered.push(<h1 key={`h1-${i}`} className="text-2xl font-bold text-foreground mt-0 mb-4">{line.slice(2)}</h1>);
      i += 1;
      continue;
    }
    if (line.startsWith("## ")) {
      rendered.push(<h2 key={`h2-${i}`} className="text-xl font-semibold text-foreground mt-6 mb-3">{line.slice(3)}</h2>);
      i += 1;
      continue;
    }
    if (line.startsWith("### ")) {
      rendered.push(<h3 key={`h3-${i}`} className="text-base font-semibold text-foreground mt-4 mb-2">{line.slice(4)}</h3>);
      i += 1;
      continue;
    }
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    if (isTableLine(line)) {
      const tableLines: string[] = [];
      let j = i;
      while (j < lines.length && isTableLine(lines[j])) {
        tableLines.push(lines[j]);
        j += 1;
      }

      const header = splitTableCells(tableLines[0] || "");
      const hasSeparator = tableLines.length > 1 && isSeparatorRow(tableLines[1]);
      const bodyStart = hasSeparator ? 2 : 1;
      const rows = tableLines.slice(bodyStart).map(splitTableCells);

      rendered.push(
        <div key={`table-${i}`} className="my-4 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {header.map((cell, idx) => (
                  <th
                    key={`th-${i}-${idx}`}
                    className="border border-border bg-muted px-3 py-2 text-left font-semibold text-foreground"
                  >
                    {renderInline(cell, `th-${i}-${idx}`)}
                  </th>
                ))}
              </tr>
            </thead>
            {rows.length > 0 && (
              <tbody>
                {rows.map((row, rowIdx) => (
                  <tr key={`tr-${i}-${rowIdx}`}>
                    {row.map((cell, cellIdx) => (
                      <td
                        key={`td-${i}-${rowIdx}-${cellIdx}`}
                        className="border border-border px-3 py-2 align-top text-foreground"
                      >
                        {renderInline(cell, `td-${i}-${rowIdx}-${cellIdx}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
      );
      i = j;
      continue;
    }
    if (BULLET_LINE_PATTERN.test(line)) {
      const bulletLines: string[] = [];
      let j = i;
      while (j < lines.length && BULLET_LINE_PATTERN.test(lines[j])) {
        bulletLines.push(lines[j]);
        j += 1;
      }
      rendered.push(
        <ul key={`ul-${i}`} className="list-disc pl-6 my-3 space-y-1">
          {bulletLines.map((item, idx) => (
            <li key={`li-${i}-${idx}`} className="text-sm text-foreground leading-relaxed">
              {renderInline(item.replace(BULLET_LINE_PATTERN, ""), `li-${i}-${idx}`)}
            </li>
          ))}
        </ul>
      );
      i = j;
      continue;
    }

    const paragraphLines: string[] = [];
    let j = i;
    while (
      j < lines.length &&
      lines[j].trim() !== "" &&
      !lines[j].startsWith("# ") &&
      !lines[j].startsWith("## ") &&
      !lines[j].startsWith("### ") &&
      !isTableLine(lines[j]) &&
      !BULLET_LINE_PATTERN.test(lines[j])
    ) {
      paragraphLines.push(lines[j].trim());
      j += 1;
    }

    rendered.push(
      <p key={`p-${i}`} className="text-sm text-foreground leading-relaxed mb-3">
        {renderInline(paragraphLines.join(" "), `p-${i}`)}
      </p>
    );
    i = j;
  }

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      {rendered}
    </div>
  );
}
