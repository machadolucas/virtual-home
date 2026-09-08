"use client";

import { useState } from "react";
import { Check, ClipboardCopy } from "lucide-react";
import { Button, Textarea, toast } from "@/ui";

/**
 * Copy the shopping list as plain text.
 *
 * The textarea is always in the DOM rather than being revealed on demand, for two reasons: the
 * clipboard API is unavailable on an insecure origin (this app is often reached over plain HTTP on
 * the LAN), and on a phone selecting the text by hand is sometimes simply easier. So the button is
 * a convenience over something that already works, never the only way out.
 */
export function CopyAsText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: "Copied", description: "The list is on your clipboard.", tone: "success" });
    } catch {
      setRevealed(true);
      toast({
        title: "Could not reach the clipboard",
        description: "The text is shown below — select it and copy by hand.",
        tone: "error",
        duration: 0,
      });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void copy()}
          icon={
            copied ? <Check aria-hidden="true" /> : <ClipboardCopy aria-hidden="true" />
          }
        >
          {copied ? "Copied" : "Copy as text"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setRevealed((value) => !value)}>
          {revealed ? "Hide the text" : "Show the text"}
        </Button>
      </div>
      {/* `hidden` rather than a visually-hidden class: `Textarea` sets `min-h-20`, and with no
          tailwind-merge in `cn()` a `sr-only` passed as `className` would lose to it. */}
      <Textarea
        readOnly
        hidden={!revealed}
        value={text}
        rows={Math.min(24, text.split("\n").length + 1)}
        aria-label="The shopping list as plain text"
        className="font-mono text-xs"
        onFocus={(event) => event.currentTarget.select()}
      />
    </div>
  );
}
