// app/recipes/[recipeId]/page.tsx
import RecipeDetailView from "@/components/RecipeDetailView";

export default function RecipePage({
  params,
}: {
  params: { recipeId: string };
}) {
  return <RecipeDetailView recipeId={params.recipeId} />;
}
