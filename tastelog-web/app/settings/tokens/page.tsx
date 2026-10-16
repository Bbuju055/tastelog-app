"use client";

import { useState } from "react";
import TokenList from "@/components/TokenList";
import CreateTokenModal from "@/components/CreateTokenModal";

export default function TokensSettingsPage() {
  const [open, setOpen] = useState(false);
  const [modalKey, setModalKey] = useState(0);

  const onOpen = () => {
    setModalKey((k) => k + 1); // required: reset modal internal state on each open
    setOpen(true);
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Capture Tokens</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Create and manage tokens used by iOS Shortcuts to submit recipe captures.
        </p>
      </div>

      {/* Inline Shortcuts help (accurate + route-free) */}
      <div className="mb-6 rounded-lg border p-4">
        <h2 className="text-sm font-medium">iOS Shortcuts quick setup</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>
            Store the token in Keychain as an item named{" "}
            <span className="font-mono">tastelog_capture_token</span>.
          </li>
          <li>
            Send header:{" "}
            <span className="font-mono">Authorization: Bearer tl_cap_...</span>
          </li>
          <li>
            Send header:{" "}
            <span className="font-mono">Idempotency-Key: &lt;uuid&gt;</span>{" "}
            (uuid v4 recommended)
          </li>
        </ol>
      </div>

      {/* Reliability guidelines */}
      <div className="mb-6 rounded-lg border p-4">
        <h2 className="text-sm font-medium">Reliability</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>
            <span className="font-medium">Timeout:</span> 30 seconds
          </li>
          <li>
            <span className="font-medium">Retry:</span> only on{" "}
            <span className="font-mono">5xx</span> responses
          </li>
          <li>
            <span className="font-medium">Idempotency:</span> reuse the same{" "}
            <span className="font-mono">Idempotency-Key</span> on retries
          </li>
        </ul>
        <p className="mt-3 text-sm text-muted-foreground">
          Reusing the same <span className="font-mono">Idempotency-Key</span>{" "}
          with the same payload returns a cached response. If the API returns{" "}
          <span className="font-mono">503</span> with &quot;Please retry with
          same Idempotency-Key.&quot;, retry with the same key.
        </p>
      </div>

      {/* TokenList owns the create button; we just provide the handler */}
      <TokenList onCreateClick={onOpen} />

      <CreateTokenModal
        key={modalKey}
        open={open}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}
