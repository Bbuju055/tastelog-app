// app/review/[draftId]/page.tsx
import DraftReviewForm from "@/components/DraftReviewForm";

export default function ReviewDraftPage({
  params,
}: {
  params: { draftId: string };
}) {
  // Route params are trusted strings from Next router; DraftReviewForm handles validation/errors.
  return <DraftReviewForm draftId={params.draftId} />;
}
