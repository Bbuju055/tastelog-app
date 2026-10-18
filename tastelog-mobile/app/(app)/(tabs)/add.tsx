import { useState, useCallback, useEffect, useRef, type MutableRefObject } from "react";
import {
  View,
  Text,
  TextInput,
  Image,
  AccessibilityInfo,
  Alert,
  AppState,
  Keyboard,
  Platform,
  ScrollView,
  Pressable,
  StyleSheet,
} from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import * as Clipboard from "expo-clipboard";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as Linking from "expo-linking";
import * as FileSystem from "expo-file-system/legacy";
import { useCaptureUpload, useCaptureURL } from "../../../lib/hooks";
import { uuidv4 } from "../../../lib/api/capture";
import { listDrafts } from "../../../lib/api/endpoints";
import { useSession } from "../../../lib/auth/context";
import { Screen, Button, SkeletonCaptureScene, SuccessBeat } from "../../../components";
import { hapticTap } from "../../../lib/haptics/haptics";
// Deep import (Issue 2, section 5.1 rule): the guard must stay real in
// suites that mock the lib/hooks barrel as object literals.
import { useNavigationGuard } from "../../../lib/hooks/useNavigationGuard";
import { captureErrorMessage } from "../../../lib/captureErrorMessage";
import { urlCaptureErrorMessage } from "../../../lib/urlCaptureErrorMessage";
import { isApiError } from "../../../lib/errors";
import { fonts, fontSize, lineHeight, spacing, radius } from "../../../theme";
import type { ThemePalette } from "../../../theme/palettes";
import { useTheme, useScreenTheme } from "../../../theme/ThemeProvider";
import type { UploadFile } from "../../../lib/api/uploadTypes";

/** How far back to look for a draft that might have been created by a timed-out capture. */
const DRAFT_RECOVERY_WINDOW_MS = 2 * 60 * 1000;

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB per image
const MAX_TOTAL_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB cumulative
const MAX_IMAGES = 5;

/**
 * Success-beat state (Phase 15.2.2). Set in a capture mutation's
 * onSuccess BEFORE any source state is reset; the retained draftId is
 * what the exactly-once completion path navigates to.
 */
type PendingCaptureBeat = {
  draftId: string;
  source: "photo" | "url";
  startedAt: number;
};

// --- Stage text during capture (timed transitions) ---

function buildStageLadder(imageCount: number): { delayMs: number; text: string }[] {
  const uploadText =
    imageCount > 1 ? `Uploading ${imageCount} images\u2026` : "Uploading image\u2026";
  return [
    { delayMs: 0, text: uploadText },
    { delayMs: 3_000, text: "Analyzing your recipe\u2026" },
    { delayMs: 30_000, text: "Still working \u2014 complex recipes take a bit longer\u2026" },
    { delayMs: 60_000, text: "Almost there\u2026" },
  ];
}

function useCaptureStage(
  isPending: boolean,
  imageCount: number,
  captureStartedAtRef: MutableRefObject<number | null>,
) {
  const [stageIndex, setStageIndex] = useState<number | null>(null);
  const stageIndexRef = useRef<number | null>(null);
  const announcedIndexRef = useRef<number | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Stage ladder — dwell timing, not motion (Phase 15.2.1 hardening,
  // approved Gate A deviation). One attempt per isPending window,
  // anchored on the capture-start timestamp the upload handler already
  // records. The stage is DERIVED from elapsed time rather than
  // accumulated timers, so iOS background timer suspension can never
  // leave stale stage copy — foregrounding re-evaluates immediately.
  // Timers only schedule re-evaluation at the ladder thresholds. The
  // ladder copy and thresholds are unchanged from the pre-15.2.1 code.
  useEffect(() => {
    if (!isPending) {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
      stageIndexRef.current = null;
      announcedIndexRef.current = null;
      setStageIndex(null);
      return;
    }

    const anchor = captureStartedAtRef.current ?? Date.now();
    const ladder = buildStageLadder(imageCount);
    stageIndexRef.current = null;
    announcedIndexRef.current = null;

    const evaluate = () => {
      const elapsed = Date.now() - anchor;
      let derived = 0;
      for (let i = 0; i < ladder.length; i++) {
        if (elapsed >= ladder[i].delayMs) derived = i;
      }
      // Per-attempt monotonic clamp: a backward wall-clock step can
      // never regress the visible stage; a fresh attempt resets via the
      // ref clears above.
      const next = Math.max(derived, stageIndexRef.current ?? 0);
      if (stageIndexRef.current !== next) {
        stageIndexRef.current = next;
        setStageIndex(next);
      }
      // Announce once per observed index change. A foreground jump
      // lands directly on the current stage, so missed intermediate
      // stages are never replayed. Android is covered by the polite
      // live region on the stage text instead (announceForAccessibility
      // there would double-speak).
      if (announcedIndexRef.current !== next) {
        announcedIndexRef.current = next;
        if (Platform.OS === "ios") {
          AccessibilityInfo.announceForAccessibility(ladder[next].text);
        }
      }
    };

    evaluate();

    timersRef.current = ladder
      .slice(1)
      .map(({ delayMs }) => {
        const remaining = delayMs - (Date.now() - anchor);
        return remaining > 0 ? setTimeout(evaluate, remaining) : null;
      })
      .filter((t): t is ReturnType<typeof setTimeout> => t !== null);

    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") evaluate();
    });

    return () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
      sub.remove();
    };
  }, [isPending, imageCount, captureStartedAtRef]);

  const ladder = buildStageLadder(imageCount);
  const stageText = stageIndex === null ? null : (ladder[stageIndex]?.text ?? null);

  return { stageIndex, stageText };
}

/**
 * Convert any image to JPEG via expo-image-manipulator.
 * Handles HEIC, HEIF, PNG, WebP, TIFF, BMP — anything iOS can display.
 * Returns a file:// URI to a guaranteed JPEG file.
 */
async function ensureJpeg(uri: string): Promise<string> {
  const context = ImageManipulator.manipulate(uri);
  const imageRef = await context.renderAsync();
  const result = await imageRef.saveAsync({
    format: SaveFormat.JPEG,
    compress: 0.85,
  });
  return result.uri;
}

function deriveFileName(asset: ImagePicker.ImagePickerAsset, index: number): string {
  const raw = asset.fileName
    ?? asset.uri.split("/").pop()
    ?? null;

  if (raw) {
    const base = raw.replace(/\.[^.]+$/, "");
    return `${base}_p${index + 1}.jpg`;
  }

  return `recipe_p${index + 1}.jpg`;
}

// ---------------------------------------------------------------------------
// Thumbnail Strip
// ---------------------------------------------------------------------------

function ThumbnailStrip({
  images,
  onRemove,
  onMoveLeft,
  onMoveRight,
  onAddMore,
  disabled,
}: {
  images: ImagePicker.ImagePickerAsset[];
  onRemove: (index: number) => void;
  onMoveLeft: (index: number) => void;
  onMoveRight: (index: number) => void;
  onAddMore: () => void;
  disabled: boolean;
}) {
  const { palette } = useTheme();
  const ss = createStripStyles(palette);
  return (
    <View style={ss.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={ss.scrollRow}
        contentContainerStyle={ss.scrollContent}
      >
        {images.map((asset, index) => (
          <View key={asset.assetId ?? `img-${index}`} style={ss.thumbWrapper}>
            {/* Page number badge */}
            <View style={ss.badge}>
              <Text style={ss.badgeText}>{index + 1}</Text>
            </View>

            <Image source={{ uri: asset.uri }} style={ss.thumb} resizeMode="cover" />

            {/* Remove button */}
            {!disabled && (
              <Pressable
                style={ss.removeBtn}
                onPress={() => {
                  hapticTap();
                  onRemove(index);
                }}
                hitSlop={6}
              >
                <Text style={ss.removeBtnText}>{"\u00D7"}</Text>
              </Pressable>
            )}

            {/* Reorder chevrons */}
            {!disabled && images.length > 1 && (
              <View style={ss.chevronRow}>
                {index > 0 ? (
                  <Pressable
                    onPress={() => {
                      hapticTap();
                      onMoveLeft(index);
                    }}
                    style={ss.chevronBtn}
                    hitSlop={4}
                  >
                    <Text style={ss.chevronText}>{"\u2039"}</Text>
                  </Pressable>
                ) : (
                  <View style={ss.chevronPlaceholder} />
                )}
                {index < images.length - 1 ? (
                  <Pressable
                    onPress={() => {
                      hapticTap();
                      onMoveRight(index);
                    }}
                    style={ss.chevronBtn}
                    hitSlop={4}
                  >
                    <Text style={ss.chevronText}>{"\u203A"}</Text>
                  </Pressable>
                ) : (
                  <View style={ss.chevronPlaceholder} />
                )}
              </View>
            )}
          </View>
        ))}

        {/* Add more button */}
        {!disabled && images.length < MAX_IMAGES && (
          <Pressable style={ss.addMoreBtn} onPress={onAddMore}>
            <Text style={ss.addMoreText}>+</Text>
          </Pressable>
        )}
      </ScrollView>

      <Text style={ss.counter}>
        {images.length} {images.length === 1 ? "page" : "pages"} selected (max {MAX_IMAGES})
      </Text>
      {images.length > 1 && (
        <Text style={ss.tip}>Tip: arrange in reading order</Text>
      )}
    </View>
  );
}

function createStripStyles(palette: ThemePalette) {
  return StyleSheet.create({
    container: {
      marginBottom: spacing.base,
      alignItems: "center",
    },
    scrollRow: {
      flexGrow: 0,
    },
    scrollContent: {
      paddingHorizontal: spacing.xs,
      gap: spacing.sm,
      alignItems: "flex-start",
    },
    thumbWrapper: {
      width: 80,
      alignItems: "center",
    },
    badge: {
      position: "absolute",
      top: 2,
      left: 2,
      zIndex: 2,
      backgroundColor: palette.surface,
      borderRadius: 10,
      width: 20,
      height: 20,
      alignItems: "center",
      justifyContent: "center",
    },
    badgeText: {
      fontFamily: fonts.bodyBold,
      color: palette.text1,
      fontSize: fontSize.sm,
    },
    thumb: {
      width: 80,
      height: 80,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: palette.border,
    },
    removeBtn: {
      position: "absolute",
      top: -4,
      right: -4,
      zIndex: 3,
      backgroundColor: palette.error,
      borderRadius: 10,
      width: 20,
      height: 20,
      alignItems: "center",
      justifyContent: "center",
    },
    removeBtnText: {
      color: palette.bg,
      fontSize: fontSize.base,
      fontWeight: "700",
      lineHeight: fontSize.base * lineHeight.tight,
    },
    chevronRow: {
      flexDirection: "row",
      justifyContent: "center",
      gap: spacing.md,
      marginTop: spacing.xs,
    },
    chevronBtn: {
      width: 28,
      height: 24,
      borderRadius: radius.sm,
      backgroundColor: palette.card,
      alignItems: "center",
      justifyContent: "center",
    },
    chevronText: {
      fontSize: fontSize.md,
      fontWeight: "700",
      color: palette.text2,
      lineHeight: fontSize.md * lineHeight.tight,
    },
    chevronPlaceholder: {
      width: 28,
      height: 24,
    },
    addMoreBtn: {
      width: 80,
      height: 80,
      borderRadius: radius.sm,
      borderWidth: 2,
      borderColor: palette.border,
      borderStyle: "dashed",
      alignItems: "center",
      justifyContent: "center",
    },
    addMoreText: {
      fontSize: fontSize.xl,
      color: palette.text3,
      fontWeight: "300",
    },
    counter: {
      fontFamily: fonts.body,
      color: palette.text3,
      fontSize: fontSize.sm,
      marginTop: spacing.sm,
      textAlign: "center",
    },
    tip: {
      fontFamily: fonts.body,
      color: palette.text4,
      fontSize: fontSize.sm,
      marginTop: 2,
      textAlign: "center",
    },
  });
}

// ---------------------------------------------------------------------------
// Main Screen
// ---------------------------------------------------------------------------

export default function AddScreen() {
  useScreenTheme("light");
  const { palette, theme } = useTheme();
  const s = createStyles(palette);
  const router = useRouter();
  const { signOut } = useSession();
  const mutation = useCaptureUpload();
  const urlMutation = useCaptureURL();
  // Build 4 (C3): duplicate-activation guard for the recovered-draft View
  // Draft push. The synchronous state null-out below does not stop a
  // same-frame second tap; the guard's ref check does.
  const navGuard = useNavigationGuard();
  const [selectedImages, setSelectedImages] = useState<ImagePicker.ImagePickerAsset[]>([]);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [fileSizeError, setFileSizeError] = useState<string | null>(null);
  const [recoveredDraftId, setRecoveredDraftId] = useState<string | null>(null);
  const captureStartRef = useRef<number | null>(null);
  // Idempotency-Key per capture attempt. The photo key follows the selected
  // images and the URL key follows the typed URL: "Try Again" on the same
  // input re-sends the same key, so the backend hands back the same draft
  // instead of creating a second one; changing the input starts a new attempt.
  const photoKeyRef = useRef<string>(uuidv4());
  const urlKeyRef = useRef<string>(uuidv4());
  // JPEG re-encoding is not byte-stable, and the key's payload identity is
  // the file bytes: reuse the converted file for a retry of the same asset.
  const jpegCacheRef = useRef(new Map<string, string>());
  const preparingRef = useRef(false);
  const { stageIndex, stageText } = useCaptureStage(
    mutation.isPending,
    selectedImages.length,
    captureStartRef,
  );

  // --- URL capture state ---
  const [urlInput, setUrlInput] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [urlStageText, setUrlStageText] = useState<string | null>(null);

  // --- Clipboard detection state ---
  const [clipboardUrl, setClipboardUrl] = useState<string | null>(null);
  const [clipboardDismissed, setClipboardDismissed] = useState(false);
  const urlInputRef = useRef(urlInput);
  urlInputRef.current = urlInput;

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setClipboardDismissed(false);

      (async () => {
        try {
          const text = (await Clipboard.getStringAsync()).trim();
          if (cancelled) return;
          if (
            (text.startsWith("http://") || text.startsWith("https://")) &&
            text.includes(".")
          ) {
            if (text === urlInputRef.current.trim()) {
              setClipboardUrl(null);
              return;
            }
            setClipboardUrl(text);
          } else {
            setClipboardUrl(null);
          }
        } catch {
          if (!cancelled) setClipboardUrl(null);
        }
      })();

      return () => { cancelled = true; };
    }, []),
  );

  // --- Success beat state (15.2.2) ---
  const [pendingBeat, setPendingBeat] = useState<PendingCaptureBeat | null>(null);

  /** Either capture path is in progress — used for mutual exclusion. */
  const anyPending = mutation.isPending || urlMutation.isPending;

  // Presentation lock for the success → beat handoff (Gate A binding
  // requirement): if React ever renders a frame after mutation success
  // but before pendingBeat lands, the last wait presentation stays up
  // and every capture control stays locked — the reset Add surface must
  // never flash behind (or before) the beat.
  const lastWaitRef = useRef<{ stage: number; text: string } | null>(null);
  if (stageIndex !== null && stageText) {
    lastWaitRef.current = { stage: stageIndex, text: stageText };
  }
  const beatActive = pendingBeat !== null;
  const photoHandoff = mutation.isSuccess && !beatActive;
  const urlHandoff = urlMutation.isSuccess && !beatActive;
  /** Every capture-surface interaction gate (defense in depth beneath the
   *  beat Modal's own touch blocking). */
  const uiLocked = anyPending || beatActive || photoHandoff || urlHandoff;

  // 401 = expired session → sign out → AuthGate redirects to login.
  // Applies to BOTH capture paths (15.3.3 URL parity): before this, a URL
  // import 401 rendered generic copy and stranded the expired session.
  useEffect(() => {
    const expired = [mutation.error, urlMutation.error].some(
      (err) => err && isApiError(err) && err.status === 401,
    );
    if (expired) {
      signOut();
    }
  }, [mutation.error, urlMutation.error, signOut]);

  // Backgrounding resilience
  useEffect(() => {
    const sub = AppState.addEventListener("change", async (state) => {
      if (state !== "active") return;
      const startTime = captureStartRef.current;
      if (!startTime || recoveredDraftId || !mutation.error) return;
      if (!isApiError(mutation.error) || (mutation.error.kind !== "timeout" && mutation.error.kind !== "network")) return;

      try {
        const drafts = await listDrafts();
        const recent = drafts.find((d) => {
          const createdAt = new Date(d.created_at).getTime();
          return createdAt > startTime
            && createdAt - startTime < DRAFT_RECOVERY_WINDOW_MS;
        });
        if (recent) {
          setRecoveredDraftId(recent.id);
          captureStartRef.current = null;
        }
      } catch {
        // Silent
      }
    });
    return () => sub.remove();
  }, [mutation.error, recoveredDraftId]);

  // --- Picker ---

  function dedup(
    existing: ImagePicker.ImagePickerAsset[],
    incoming: ImagePicker.ImagePickerAsset[],
  ): ImagePicker.ImagePickerAsset[] {
    const seen = new Set(existing.map((a) => a.assetId).filter(Boolean));
    const unique = incoming.filter((a) => !a.assetId || !seen.has(a.assetId));
    return [...existing, ...unique].slice(0, MAX_IMAGES);
  }

  const handlePickImage = useCallback(async () => {
    if (uiLocked) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setPermissionDenied(true);
      mutation.reset();
      return;
    }
    setPermissionDenied(false);

    const remaining = MAX_IMAGES - selectedImages.length;
    if (selectedImages.length > 0 && remaining <= 0) return;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
      allowsMultipleSelection: true,
      selectionLimit: selectedImages.length === 0 ? MAX_IMAGES : remaining,
    });

    if (result.canceled || result.assets.length === 0) return;

    if (selectedImages.length === 0) {
      setSelectedImages(result.assets.slice(0, MAX_IMAGES));
    } else {
      setSelectedImages((prev) => dedup(prev, result.assets));
    }
    setFileSizeError(null);
    setRecoveredDraftId(null);
    mutation.reset();
  }, [mutation, selectedImages, uiLocked]);

  const handleRemoveImage = useCallback((index: number) => {
    setSelectedImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleMoveLeft = useCallback((index: number) => {
    if (index <= 0) return;
    setSelectedImages((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  }, []);

  const handleMoveRight = useCallback((index: number) => {
    setSelectedImages((prev) => {
      if (index >= prev.length - 1) return prev;
      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
  }, []);

  // --- Upload ---

  useEffect(() => {
    photoKeyRef.current = uuidv4();
  }, [selectedImages]);
  useEffect(() => {
    urlKeyRef.current = uuidv4();
  }, [urlInput]);

  const handleUpload = useCallback(async () => {
    if (selectedImages.length === 0 || uiLocked || preparingRef.current) return;
    // Snapshot the selection AND its key before the first await: the controls
    // stay enabled while the JPEGs are prepared, and a selection change in
    // that window rotates the key. The bytes and the key must belong to the
    // same attempt, and two preparations must not overlap.
    const images = selectedImages;
    const idempotencyKey = photoKeyRef.current;
    preparingRef.current = true;
    try {
      const jpegFiles: UploadFile[] = [];
      let totalSize = 0;

      for (let i = 0; i < images.length; i++) {
        const asset = images[i];
        let jpegUri = jpegCacheRef.current.get(asset.uri);
        if (!jpegUri) {
          jpegUri = await ensureJpeg(asset.uri);
          jpegCacheRef.current.set(asset.uri, jpegUri);
        }

        const fileInfo = await FileSystem.getInfoAsync(jpegUri);
        if (fileInfo.exists && "size" in fileInfo) {
          if (fileInfo.size > MAX_FILE_SIZE_BYTES) {
            setFileSizeError(
              images.length > 1
                ? `Image ${i + 1} is too large (over 10 MB). Try a smaller photo.`
                : "This image is too large (over 10 MB). Try cropping or using a smaller photo.",
            );
            return;
          }
          totalSize += fileInfo.size;
        }

        jpegFiles.push({
          uri: jpegUri,
          type: "image/jpeg",
          name: deriveFileName(asset, i),
        });
      }

      if (totalSize > MAX_TOTAL_SIZE_BYTES) {
        setFileSizeError("Total image size exceeds 20 MB. Try fewer or smaller images.");
        return;
      }
      setFileSizeError(null);

      setRecoveredDraftId(null);

      const captureStartedAt = Date.now();
      captureStartRef.current = captureStartedAt;

      mutation.mutate(
        { images: jpegFiles, idempotencyKey },
        {
          onSuccess: (result) => {
            // Beat state FIRST — image clearing, mutation reset, and the
            // navigation all happen in the exactly-once completion path.
            captureStartRef.current = null;
            setPendingBeat({
              draftId: result.id,
              source: "photo",
              startedAt: Date.now(),
            });
          },
          onError: async (err) => {
            if (!isApiError(err) || (err.kind !== "timeout" && err.kind !== "network")) return;

            try {
              const drafts = await listDrafts();
              const recent = drafts.find((d) => {
                const createdAt = new Date(d.created_at).getTime();
                return createdAt > captureStartedAt
                  && createdAt - captureStartedAt < DRAFT_RECOVERY_WINDOW_MS;
              });
              if (recent) {
                setRecoveredDraftId(recent.id);
                captureStartRef.current = null;
              }
            } catch {
              // Recovery check failed
            }
          },
        },
      );
    } finally {
      preparingRef.current = false;
    }
  }, [selectedImages, mutation, uiLocked]);

  // --- URL capture ---

  const urlStageTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  function clearUrlStageTimers() {
    urlStageTimersRef.current.forEach(clearTimeout);
    urlStageTimersRef.current = [];
    setUrlStageText(null);
  }

  useEffect(() => {
    return () => { clearUrlStageTimers(); };
  }, []);

  function extractDomain(url: string): string {
    try {
      const host = new URL(url).hostname;
      return host.startsWith("www.") ? host.slice(4) : host;
    } catch {
      return url;
    }
  }

  function normalizeUrlInput(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return trimmed;
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
    if (trimmed.includes(".")) return `https://${trimmed}`;
    return trimmed;
  }

  const handleUrlImport = useCallback(() => {
    if (uiLocked) return;
    Keyboard.dismiss();

    const normalized = normalizeUrlInput(urlInput);
    if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
      setUrlError("Paste a full link starting with https://");
      return;
    }

    setUrlError(null);
    clearUrlStageTimers();
    setUrlStageText("Opening recipe page\u2026");

    const stages: { delayMs: number; text: string }[] = [
      { delayMs: 3_000, text: "Pulling in ingredients and steps\u2026" },
      { delayMs: 10_000, text: "This page needs a deeper read\u2026" },
      { delayMs: 25_000, text: "Almost there\u2026" },
    ];
    urlStageTimersRef.current = stages.map(({ delayMs, text }) =>
      setTimeout(() => setUrlStageText(text), delayMs),
    );

    urlMutation.mutate(
      { url: normalized, idempotencyKey: urlKeyRef.current },
      {
        onSuccess: (result) => {
          // Beat state FIRST. The URL stage text and input are cleared
          // in the exactly-once completion path, so the last wait
          // presentation stays visible through the handoff frame.
          setPendingBeat({
            draftId: result.id,
            source: "url",
            startedAt: Date.now(),
          });
        },
        onError: (err) => {
          clearUrlStageTimers();
          const info = urlCaptureErrorMessage(err);

          if (info.duplicate) {
            const { type, id } = info.duplicate;
            const actionLabel = type === "recipe" ? "View Recipe" : "Review Draft";
            const route = type === "recipe" ? "/(app)/recipe/[id]" as const : "/(app)/draft/[id]" as const;

            Alert.alert(info.title, info.body, [
              { text: "Cancel", style: "cancel" },
              {
                text: actionLabel,
                onPress: () => router.push({ pathname: route, params: { id } }),
              },
            ]);
          } else {
            setUrlError(info.body);
          }
        },
      },
    );
  }, [urlInput, uiLocked, urlMutation]);

  // --- Success-beat completion (exactly-once via SuccessBeat's guard) ---

  const handleBeatComplete = useCallback(() => {
    const beat = pendingBeat;
    if (!beat) return;
    setPendingBeat(null);
    if (beat.source === "photo") {
      setSelectedImages([]);
      mutation.reset();
    } else {
      clearUrlStageTimers();
      setUrlInput("");
      urlMutation.reset();
    }
    router.push({
      pathname: "/(app)/draft/[id]",
      params: { id: beat.draftId },
    });
  }, [pendingBeat, mutation, urlMutation, router]);

  // --- Render ---

  const hasImages = selectedImages.length > 0;

  const content = (
    <>
      <Text style={s.title}>Capture Recipe</Text>

      {hasImages ? (
        <ThumbnailStrip
          images={selectedImages}
          onRemove={handleRemoveImage}
          onMoveLeft={handleMoveLeft}
          onMoveRight={handleMoveRight}
          onAddMore={handlePickImage}
          disabled={uiLocked}
        />
      ) : null}

      {(stageIndex !== null && stageText) ||
      (photoHandoff && lastWaitRef.current) ? (
        <View style={s.captureWait}>
          {/* During the photo success→beat handoff frame the hook has
              already cleared, so the last wait presentation holds. */}
          <SkeletonCaptureScene
            stage={stageIndex ?? lastWaitRef.current?.stage ?? 0}
          />
          {/* The accessible capture status. iOS stage announcements come
              from the hook; Android reads this polite live region. */}
          <Text style={s.stageText} accessibilityLiveRegion="polite">
            {stageText ?? lastWaitRef.current?.text ?? ""}
          </Text>
        </View>
      ) : permissionDenied ? (
        <View style={s.errorContainer}>
          <Text style={s.errorTitle}>Photo access required</Text>
          <Text style={s.errorBody}>
            Tastelog needs access to your photo library to capture recipes.
          </Text>
          <Button
            title="Open Settings"
            onPress={() => Linking.openSettings()}
            variant="outline"
          />
        </View>
      ) : fileSizeError ? (
        <View style={s.errorContainer}>
          <Text style={s.errorTitle}>Image too large</Text>
          <Text style={s.errorBody}>{fileSizeError}</Text>
        </View>
      ) : recoveredDraftId ? (
        <View style={s.successContainer}>
          <Text style={s.successTitle}>Recipe saved</Text>
          <Text style={s.successBody}>
            Good news — your recipe was actually saved. Tap below to review it.
          </Text>
          <Button
            title="View Draft"
            onPress={() =>
              navGuard.guard(() => {
                setRecoveredDraftId(null);
                setSelectedImages([]);
                mutation.reset();
                router.push({
                  pathname: "/(app)/draft/[id]",
                  params: { id: recoveredDraftId },
                });
              })
            }
            variant="outline"
          />
        </View>
      ) : mutation.error ? (
        <View style={s.errorContainer}>
          {(() => {
            const info = captureErrorMessage(mutation.error);
            return (
              <>
                <Text style={s.errorTitle}>{info.title}</Text>
                <Text style={s.errorBody}>{info.body}</Text>
                {info.retryable && hasImages ? (
                  <Button
                    title="Try Again"
                    onPress={() => {
                      mutation.reset();
                      handleUpload();
                    }}
                    variant="outline"
                  />
                ) : null}
              </>
            );
          })()}
        </View>
      ) : null}

      <View style={s.actions}>
        <Button
          title={hasImages ? "Change Photos" : "Pick Photos from Gallery"}
          onPress={handlePickImage}
          variant="outline"
          disabled={uiLocked}
        />

        {hasImages ? (
          <Button
            title="Upload & Capture"
            onPress={handleUpload}
            variant="primary"
            loading={mutation.isPending}
            disabled={uiLocked}
          />
        ) : null}
      </View>

      {/* --- URL Capture Section --- */}
      <View style={s.urlSection}>
        <View style={s.divider}>
          <View style={s.dividerLine} />
          <Text style={s.dividerText}>Paste a recipe link</Text>
          <View style={s.dividerLine} />
        </View>

        {clipboardUrl && !clipboardDismissed && !uiLocked ? (
          <Pressable
            style={s.clipboardBanner}
            onPress={() => {
              hapticTap();
              setUrlInput(clipboardUrl);
              setClipboardUrl(null);
              setUrlError(null);
              urlMutation.reset();
            }}
          >
            <Text style={s.clipboardText} numberOfLines={1}>
              Paste from clipboard: {extractDomain(clipboardUrl)}
            </Text>
            <Pressable
              onPress={(e) => {
                e.stopPropagation();
                setClipboardDismissed(true);
              }}
              hitSlop={8}
              style={s.clipboardDismiss}
            >
              <Text style={s.clipboardDismissText}>{"\u00D7"}</Text>
            </Pressable>
          </Pressable>
        ) : null}

        <View style={s.urlRow}>
          <TextInput
            style={[s.urlInput, uiLocked && s.urlInputDisabled]}
            value={urlInput}
            onChangeText={(v) => {
              setUrlInput(v);
              setUrlError(null);
              urlMutation.reset();
            }}
            placeholder="https://example.com/recipe"
            placeholderTextColor={palette.text4}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            keyboardAppearance={theme === "dark" ? "dark" : "light"}
            editable={!uiLocked}
            returnKeyType="go"
            onSubmitEditing={handleUrlImport}
          />
          <Button
            title="Import"
            onPress={handleUrlImport}
            variant="outline"
            loading={urlMutation.isPending}
            disabled={uiLocked || urlInput.trim().length === 0}
          />
        </View>

        {urlStageText ? (
          <Text style={s.urlStageText}>{urlStageText}</Text>
        ) : null}

        {urlError ? (
          <Text style={s.urlErrorText}>{urlError}</Text>
        ) : null}
      </View>
    </>
  );

  return (
    <Screen>
      {/* While the beat Modal is up (it blocks all touch on its own),
          the underlying surface is ALSO pointer-blocked and hidden from
          assistive technology — defense in depth, not implicit Modal
          behavior. */}
      <View
        style={s.flexRoot}
        pointerEvents={beatActive ? "none" : "auto"}
        accessibilityElementsHidden={beatActive}
        importantForAccessibility={beatActive ? "no-hide-descendants" : "auto"}
      >
        <ScrollView
          contentContainerStyle={[s.scrollContent, !hasImages && s.scrollContentCentered]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {content}
        </ScrollView>
      </View>
      {pendingBeat ? (
        <SuccessBeat
          title={
            pendingBeat.source === "photo" ? "Recipe captured" : "Recipe imported"
          }
          accessibilityHint="Opens the draft for review."
          variant="full"
          startedAt={pendingBeat.startedAt}
          onComplete={handleBeatComplete}
        />
      ) : null}
    </Screen>
  );
}

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    flexRoot: {
      flex: 1,
    },
    scrollContent: {
      alignItems: "center",
      paddingTop: spacing.base,
      paddingBottom: spacing.xxxl,
    },
    scrollContentCentered: {
      flexGrow: 1,
      justifyContent: "center",
    },
    title: {
      fontFamily: fonts.heading,
      fontSize: fontSize.xl,
      color: palette.text1,
      marginBottom: spacing.xl,
      letterSpacing: -0.3,
    },
    captureWait: {
      width: "100%",
      marginBottom: spacing.base,
    },
    stageText: {
      fontFamily: fonts.body,
      color: palette.text3,
      textAlign: "center",
      marginBottom: spacing.base,
      fontSize: fontSize.md,
    },
    errorContainer: {
      alignItems: "center",
      marginBottom: spacing.base,
    },
    errorTitle: {
      fontFamily: fonts.bodySemiBold,
      color: palette.error,
      textAlign: "center",
      fontSize: fontSize.base,
      marginBottom: spacing.xs,
    },
    errorBody: {
      fontFamily: fonts.body,
      color: palette.error,
      textAlign: "center",
      fontSize: fontSize.base,
      marginBottom: spacing.md,
    },
    successContainer: {
      alignItems: "center",
      marginBottom: spacing.base,
    },
    successTitle: {
      fontFamily: fonts.bodySemiBold,
      color: palette.success,
      textAlign: "center",
      fontSize: fontSize.base,
      marginBottom: spacing.xs,
    },
    successBody: {
      fontFamily: fonts.body,
      color: palette.success,
      textAlign: "center",
      fontSize: fontSize.base,
      marginBottom: spacing.md,
    },
    actions: {
      width: "100%",
      gap: spacing.md,
    },
    urlSection: {
      width: "100%",
      marginTop: spacing.xxl,
    },
    divider: {
      flexDirection: "row",
      alignItems: "center",
      marginBottom: spacing.base,
    },
    dividerLine: {
      flex: 1,
      height: 1,
      backgroundColor: palette.border,
    },
    dividerText: {
      fontFamily: fonts.bodySemiBold,
      color: palette.text3,
      fontSize: fontSize.sm,
      marginHorizontal: spacing.md,
    },
    urlRow: {
      flexDirection: "row",
      gap: spacing.sm,
      alignItems: "flex-start",
    },
    urlInput: {
      flex: 1,
      borderWidth: 1,
      borderColor: palette.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      fontSize: fontSize.md,
      fontFamily: fonts.body,
      color: palette.text1,
      backgroundColor: palette.card,
    },
    urlInputDisabled: {
      backgroundColor: palette.disabledBg,
      color: palette.disabledText,
    },
    urlStageText: {
      fontFamily: fonts.body,
      color: palette.text3,
      fontSize: fontSize.sm,
      marginTop: spacing.sm,
      textAlign: "center",
    },
    urlErrorText: {
      fontFamily: fonts.body,
      color: palette.error,
      fontSize: fontSize.sm,
      marginTop: spacing.sm,
    },
    clipboardBanner: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: palette.accentWash,
      borderWidth: 1,
      borderColor: palette.accentSoft,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      marginBottom: spacing.md,
    },
    clipboardText: {
      flex: 1,
      fontFamily: fonts.bodyMedium,
      color: palette.accent,
      fontSize: fontSize.base,
    },
    clipboardDismiss: {
      marginLeft: spacing.sm,
      width: 24,
      height: 24,
      alignItems: "center",
      justifyContent: "center",
    },
    clipboardDismissText: {
      color: palette.text3,
      fontSize: fontSize.md,
      fontWeight: "600",
      lineHeight: fontSize.md * lineHeight.tight,
    },
  });
}
