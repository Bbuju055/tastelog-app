// app/recipes/[recipeId]/page.tsx
import RecipeDetailView from "@/components/RecipeDetailView";

export default async function RecipePage({
  params,
}: {
  params: Promise<{ recipeId: string }>;
}) {
  // Next 16 delivers route params as a Promise; see app/review/[draftId]/page.tsx.
  const { recipeId } = await params;
  return <RecipeDetailView recipeId={recipeId} />;
}
