// app/add/page.tsx
"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";

import UploadDropzone from "@/components/UploadDropzone";
import { captureDraft } from "@/lib/api/endpoints";
import { apiErrorMessage } from "@/lib/useApiErrorMessage";

// shadcn/ui
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function AddPage() {
  const router = useRouter();

  const [file, setFile] = useState<File | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const filename = useMemo(() => file?.name ?? null, [file]);

  const captureMutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("No file selected.");

      // Backend expects multipart form. Field name is "image" (verified in your curl).
      const form = new FormData();
      form.append("image", file);

      return captureDraft(form);
    },
    onSuccess: (draft) => {
      const draftId = draft?.id;
      if (!draftId || typeof draftId !== "string") {
        setErrorMsg("Capture succeeded but response is missing draft id.");
        return;
      }

      router.replace(`/review/${encodeURIComponent(draftId)}`);
      router.refresh();
    },
    onError: (err) => setErrorMsg(apiErrorMessage(err)),
  });

  const busy = captureMutation.isPending;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Upload Recipe</CardTitle>
          <p className="mt-1 text-sm text-neutral-600">
            Upload a photo or PDF. We&apos;ll parse it into a draft you can review
            before saving.
          </p>

          {errorMsg ? (
            <div
              className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              role="alert"
            >
              {errorMsg}
            </div>
          ) : null}
        </CardHeader>

        <CardContent className="space-y-4">
          <UploadDropzone
            disabled={busy}
            onFileSelected={(f) => {
              setErrorMsg(null);
              setFile(f);
            }}
          />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-neutral-600">
              {filename ? (
                <>
                  Selected: <span className="font-medium">{filename}</span>
                </>
              ) : (
                "No file selected yet."
              )}
            </div>

            <Button
              type="button"
              onClick={() => {
                setErrorMsg(null);
                captureMutation.mutate();
              }}
              disabled={!file || busy}
            >
              {busy ? "Parsing…" : "Parse Recipe"}
            </Button>
          </div>

          <div className="text-xs text-neutral-500">
            Nothing is saved until you review and confirm the draft.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
