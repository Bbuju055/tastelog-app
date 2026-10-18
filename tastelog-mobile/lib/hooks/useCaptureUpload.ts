import { useMutation } from "@tanstack/react-query";
import { captureDraft } from "../api/endpoints";
import { hapticWarning } from "../haptics/haptics";
import type { DraftResponse } from "../api/schemas";
import type { UploadFile } from "../api/uploadTypes";
import type { ApiError } from "../errors";

/** RN FormData accepts { uri, name, type } file-part objects, not Blob. */
function asFormDataFile(file: UploadFile): Blob {
  return { uri: file.uri, name: file.name, type: file.type } as unknown as Blob;
}

type CaptureUploadInput = {
  images: UploadFile[];
  /** Minted by the screen when the images are chosen and kept until they
   *  change, so "Try Again" replays the same attempt instead of creating a
   *  second draft. */
  idempotencyKey: string;
};

export function useCaptureUpload() {
  return useMutation<DraftResponse, ApiError, CaptureUploadInput>({
    mutationFn: ({ images, idempotencyKey }) => {
      const form = new FormData();
      for (const img of images) {
        form.append("image", asFormDataFile(img));
      }
      return captureDraft(form, idempotencyKey);
    },
    // 15.2 Gate A (F2): the success haptic is owned by SuccessBeat — the
    // visible acknowledgment every successful capture mounts. A hook-level
    // haptic here would double-fire it.
    onError: () => {
      hapticWarning();
    },
  });
}
