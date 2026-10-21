// app/page.tsx
"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { listRecipes, searchRecipes } from "@/lib/api/endpoints";
import type { RecipeSearchResult } from "@/lib/api/schemas";
import { apiErrorMessage } from "@/lib/useApiErrorMessage";

// shadcn/ui
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function recipesListKey(limit: number, offset: number) {
  return ["recipes", "list", limit, offset] as const;
}

function recipesSearchKey(q: string, limit: number) {
  return ["recipes", "search", q, limit] as const;
}

export default function HomePage() {
  const [q, setQ] = useState("");
  const [submittedQ, setSubmittedQ] = useState("");

  const limit = 24;
  const offset = 0;

  const isSearching = submittedQ.trim().length > 0;
  const activeQuery = submittedQ.trim();

  const listQuery = useQuery({
    queryKey: recipesListKey(limit, offset),
    queryFn: () => listRecipes({ limit, offset }),
    enabled: !isSearching,
  });

  const searchQuery = useQuery({
    queryKey: recipesSearchKey(activeQuery, limit),
    queryFn: () => searchRecipes({ q: activeQuery, limit }),
    enabled: isSearching,
  });

  const loading = listQuery.isLoading || searchQuery.isLoading;
  const error = listQuery.error ?? searchQuery.error;

  const recipes: RecipeSearchResult[] = useMemo(() => {
    const data = isSearching ? searchQuery.data : listQuery.data;
    return Array.isArray(data) ? data : [];
  }, [isSearching, listQuery.data, searchQuery.data]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <CardTitle>Recipes</CardTitle>
            <p className="text-sm text-neutral-600">
              Search your saved recipes or add a new one.
            </p>
          </div>

          <Button asChild>
            <Link href="/add">Add Recipe</Link>
          </Button>
        </CardHeader>

        <CardContent className="space-y-4">
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-center"
            onSubmit={(e) => {
              e.preventDefault();
              setSubmittedQ(q.trim());
            }}
          >
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search recipes…"
            />
            <div className="flex gap-2">
              <Button type="submit" variant="outline">
                Search
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setQ("");
                  setSubmittedQ("");
                }}
                disabled={!isSearching && q.length === 0}
              >
                Clear
              </Button>
            </div>
          </form>

          {error ? (
            <div
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              role="alert"
            >
              {apiErrorMessage(error)}
            </div>
          ) : null}

          {loading ? (
            <div className="text-sm text-neutral-700" aria-live="polite">
              Loading…
            </div>
          ) : recipes.length === 0 ? (
            <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-6 text-center text-sm text-neutral-700">
              {isSearching ? "No matching recipes." : "No recipes yet."}
              <div className="mt-2">
                <Button asChild size="sm">
                  <Link href="/add">Add your first recipe</Link>
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {recipes.map((r) => {
                const id = r?.id;
                const title =
                  typeof r?.title === "string" && r.title.trim()
                    ? r.title
                    : "Untitled recipe";

                return (
                  <Link
                    key={String(id)}
                    href={`/recipes/${encodeURIComponent(String(id))}`}
                    className="rounded-xl border border-neutral-200 bg-white p-4 hover:bg-neutral-50"
                  >
                    <div className="text-sm font-semibold">{title}</div>
                  </Link>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
