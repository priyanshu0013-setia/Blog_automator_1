import { useState } from "react";
import { Link } from "wouter";
import { useListArticles, useDeleteArticle, useRetryArticle, getListArticlesQueryKey } from "@workspace/api-client-react";
import type { Article } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { StatusBadge, AiSignatureRetryCount } from "@/components/shared";
import { Trash2, RefreshCw, Eye, ExternalLink, Filter } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";

const STATUS_FILTERS = [
  { value: "", label: "All" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "flagged", label: "Flagged" },
];

export default function History() {
  const [statusFilter, setStatusFilter] = useState("");
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: articles, isLoading } = useListArticles(
    statusFilter ? { status: statusFilter } : undefined,
    { query: { refetchInterval: 10000, queryKey: getListArticlesQueryKey(statusFilter ? { status: statusFilter } : undefined) } }
  );

  const deleteArticle = useDeleteArticle({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListArticlesQueryKey() });
        toast({ title: "Article deleted" });
      },
    },
  });

  const retryArticle = useRetryArticle({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListArticlesQueryKey() });
        toast({ title: "Article queued for retry" });
      },
    },
  });

  const displayed = (articles ?? []).filter((a: Article) =>
    !statusFilter || a.status === statusFilter
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Article History</h1>
          <p className="text-sm text-muted-foreground mt-1">All completed, failed, and flagged articles</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2">
        <Filter className="h-4 w-4 text-muted-foreground" />
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            data-testid={`filter-${f.value || "all"}`}
            onClick={() => setStatusFilter(f.value)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              statusFilter === f.value
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-16 bg-muted rounded-lg animate-pulse" />
          ))}
        </div>
      ) : displayed.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg p-16 text-center">
          <p className="text-sm text-muted-foreground">No articles found{statusFilter ? ` with status "${statusFilter}"` : ""}.</p>
          <Link href="/new">
            <button className="mt-3 text-sm text-primary hover:underline">Generate your first article</button>
          </Link>
        </div>
      ) : (
        <div className="bg-card border border-card-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left py-3 px-4 font-medium text-muted-foreground">Article</th>
                  <th className="text-left py-3 px-4 font-medium text-muted-foreground">Status</th>
                  <th className="text-left py-3 px-4 font-medium text-muted-foreground">AI Retries</th>
                  <th className="text-left py-3 px-4 font-medium text-muted-foreground">Keyword %</th>
                  <th className="text-left py-3 px-4 font-medium text-muted-foreground">Em Dashes</th>
                  <th className="text-left py-3 px-4 font-medium text-muted-foreground">FAQs</th>
                  <th className="text-left py-3 px-4 font-medium text-muted-foreground">Date</th>
                  <th className="text-right py-3 px-4 font-medium text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {displayed.map((article: Article) => (
                  <tr
                    key={article.id}
                    data-testid={`row-article-${article.id}`}
                    className="hover:bg-muted/30 transition-colors"
                  >
                    <td className="py-3 px-4">
                      <div className="max-w-xs">
                        <p className="font-medium text-foreground truncate">{article.title || article.topic}</p>
                        <p className="text-xs text-muted-foreground truncate">{article.primaryKeyword}</p>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <StatusBadge status={article.status} />
                    </td>
                    <td className="py-3 px-4">
                      <AiSignatureRetryCount count={article.aiSignatureRetryCount} />
                    </td>
                    <td className="py-3 px-4">
                      {article.primaryKeywordDensity != null ? (
                        <span className={`font-mono text-xs ${
                          article.primaryKeywordDensity >= 1.3 && article.primaryKeywordDensity <= 1.7
                            ? "text-green-600" : "text-amber-600"
                        }`}>
                          {article.primaryKeywordDensity.toFixed(1)}%
                        </span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="py-3 px-4">
                      {article.emDashCount != null ? (
                        <span className={`font-mono text-xs ${
                          article.emDashCount <= 2 ? "text-green-600"
                            : article.emDashCount <= 4 ? "text-amber-600"
                            : "text-red-600 font-bold"
                        }`} title="Target: 0–2 per 1000 words">
                          {article.emDashCount}
                        </span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="py-3 px-4">
                      {article.faqCount != null ? (
                        <span className={`font-mono text-xs ${
                          [2, 3, 5].includes(article.faqCount) ? "text-green-600" : "text-amber-600"
                        }`} title="Allowed: 2, 3, or 5">
                          {article.faqCount}
                        </span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="py-3 px-4 text-xs text-muted-foreground whitespace-nowrap">
                      {formatDistanceToNow(new Date(article.createdAt), { addSuffix: true })}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-end gap-1">
                        <Link href={`/article/${article.id}`}>
                          <button
                            data-testid={`button-view-${article.id}`}
                            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                            title="View"
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                        </Link>
                        {article.googleDocUrl && (
                          <a href={article.googleDocUrl} target="_blank" rel="noopener noreferrer">
                            <button className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Open Google Doc">
                              <ExternalLink className="h-4 w-4" />
                            </button>
                          </a>
                        )}
                        {(article.status === "failed" || article.status === "flagged") && (
                          <button
                            data-testid={`button-retry-${article.id}`}
                            onClick={() => retryArticle.mutate({ id: article.id })}
                            className="p-1.5 rounded text-amber-500 hover:text-amber-700 hover:bg-amber-50 dark:hover:bg-amber-950/20 transition-colors"
                            title="Retry"
                          >
                            <RefreshCw className="h-4 w-4" />
                          </button>
                        )}
                        <button
                          data-testid={`button-delete-${article.id}`}
                          onClick={() => {
                            if (confirm("Delete this article?")) {
                              deleteArticle.mutate({ id: article.id });
                            }
                          }}
                          className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
