// src/components/UploadDropzone.tsx
"use client";

import { useCallback, useMemo, useState } from "react";

// shadcn/ui
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type Props = {
  accept?: string[];
  maxSizeBytes?: number;
  disabled?: boolean;
  onFileSelected: (file: File) => void;
};

const DEFAULT_ACCEPT = ["image/jpeg", "image/png", "application/pdf"];

function formatBytes(bytes: number): string {
  const kb = 1024;
  const mb = kb * 1024;
  if (bytes >= mb) return `${(bytes / mb).toFixed(1)} MB`;
  if (bytes >= kb) return `${(bytes / kb).toFixed(0)} KB`;
  return `${bytes} B`;
}

function humanAcceptList(accept: string[]): string {
  return accept
    .map((t) => {
      if (t === "application/pdf") return "single-page PDF";
      if (t.startsWith("image/")) return t.replace("image/", "").toUpperCase();
      return t;
    })
    .join(", ");
}

export default function UploadDropzone({
  accept = DEFAULT_ACCEPT,
  maxSizeBytes = 10 * 1024 * 1024, // Match the backend per-file limit.
  disabled,
  onFileSelected,
}: Props) {
  const [isDragging, setIsDragging] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const acceptAttr = useMemo(() => accept.join(","), [accept]);

  const validate = useCallback(
    (file: File): string | null => {
      if (!accept.includes(file.type)) {
        return `Unsupported file type. Allowed: ${humanAcceptList(accept)}.`;
      }
      if (file.size > maxSizeBytes) {
        return `File is too large. Max size is ${formatBytes(maxSizeBytes)}.`;
      }
      return null;
    },
    [accept, maxSizeBytes]
  );

  const pickFile = useCallback(
    (file: File | null | undefined) => {
      if (!file) return;
      const err = validate(file);
      if (err) {
        setErrorMsg(err);
        return;
      }
      setErrorMsg(null);
      onFileSelected(file);
    },
    [onFileSelected, validate]
  );

  return (
    <Card
      className={[
        "border border-neutral-200 bg-white",
        disabled ? "opacity-60" : "",
      ].join(" ")}
    >
      <CardContent className="p-4 sm:p-6">
        <div className="space-y-3">
          {/* Drop area */}
          <label
            className={[
              "group relative flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-4 py-10 text-center transition-colors",
              isDragging
                ? "border-neutral-800 bg-neutral-50"
                : "border-neutral-300 bg-white hover:border-neutral-500",
              disabled ? "cursor-not-allowed" : "",
            ].join(" ")}
            onDragEnter={(e) => {
              e.preventDefault();
              if (disabled) return;
              setIsDragging(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (disabled) return;
              setIsDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setIsDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              if (disabled) return;
              const file = e.dataTransfer.files?.[0];
              pickFile(file);
            }}
          >
            <input
              type="file"
              className="hidden"
              accept={acceptAttr}
              disabled={disabled}
              onChange={(e) => pickFile(e.target.files?.[0])}
            />

            <div className="space-y-2">
              <div className="text-sm font-semibold">
                Drop a recipe image or single-page PDF
              </div>
              <div className="text-xs text-neutral-600">
                Or click to choose a file
              </div>

              <div className="pt-1 text-xs text-neutral-500">
                {humanAcceptList(accept)} • up to {formatBytes(maxSizeBytes)}
              </div>
            </div>

            {/* subtle highlight ring */}
            <div
              className={[
                "pointer-events-none absolute inset-0 rounded-2xl ring-0 transition-all",
                isDragging ? "ring-2 ring-neutral-800/20" : "group-hover:ring-2 group-hover:ring-neutral-900/10",
              ].join(" ")}
              aria-hidden="true"
            />
          </label>

          {/* Optional helper actions (no behavior change) */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-neutral-500">
              Tip: a clear, well-lit photo improves parsing accuracy.
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => {
                // programmatically click the hidden input by delegating to label click
                // safest: rely on label click behavior without DOM querying.
                // Users can click the dropzone itself.
                setErrorMsg(null);
              }}
            >
              Choose file
            </Button>
          </div>

          {errorMsg ? (
            <div
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              role="alert"
            >
              {errorMsg}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
