// app/review/[draftId]/page.tsx
import DraftReviewForm from "@/components/DraftReviewForm";

export default async function ReviewDraftPage({
  params,
}: {
  params: Promise<{ draftId: string }>;
}) {
  // Next 16 delivers route params as a Promise; reading a property without
  // awaiting yields undefined and the form asks the API for /drafts/undefined.
  // DraftReviewForm handles validation/errors for the resolved string.
  const { draftId } = await params;
  return <DraftReviewForm draftId={draftId} />;
}
