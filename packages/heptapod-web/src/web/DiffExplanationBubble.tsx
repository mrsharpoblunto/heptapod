"use client";

import { MessageCircle } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent } from "react";
import type { DiffExplanation } from "@thestraylight/heptapod-core/types";

export function explanationLocation(note: DiffExplanation): string {
  const end = note.endLine ?? note.startLine;
  return `${note.side === "LEFT" ? "Original" : "Updated"} ${end === note.startLine ? `line ${note.startLine}` : `lines ${note.startLine}–${end}`}`;
}

/** Keep explanation prose as text, with explicit HTTP(S) Markdown links. */
export function ExplanationText({ text }: { text: string }) {
  return text.split(/(`[^`]*`|\[[^\]\n]+\]\((?:[^\s()]|\([^\s()]*\))+\))/g).map((part, index) => {
    const link = part.match(/^\[([^\]\n]+)\]\((.+)\)$/);
    if (link) {
      try {
        const url = new URL(link[2]);
        if (["https:", "http:"].includes(url.protocol)) {
          return <a href={url.href} target="_blank" rel="noopener noreferrer" key={index}>{link[1]}</a>;
        }
      } catch { /* Invalid destinations remain visible as text. */ }
    }
    return part;
  });
}

export function DiffExplanationBubble({ explanations, onActiveChange }: {
  explanations: DiffExplanation[];
  onActiveChange: (notes: DiffExplanation[], active: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  const cancelClose = () => { clearTimeout(closeTimer.current); };
  const show = () => { cancelClose(); setOpen(true); };
  const deferClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (!button.current?.matches(":focus") && !popup.current?.matches(":focus-within")) setOpen(false);
    }, 150);
  };
  const blur = (event: FocusEvent) => {
    cancelClose();
    if (event.relatedTarget instanceof Node && (button.current?.contains(event.relatedTarget) || popup.current?.contains(event.relatedTarget))) return;
    setOpen(false);
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (!open) return;
    onActiveChange(explanations, true);
    return () => onActiveChange(explanations, false);
  }, [open, explanations, onActiveChange]);
  useLayoutEffect(() => {
    if (!open || !button.current || !popup.current) return;
    const anchor = button.current.getBoundingClientRect(), bounds = popup.current.getBoundingClientRect();
    setPosition({
      left: Math.max(12, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 12)),
      top: Math.max(12, anchor.bottom + 8 + bounds.height <= window.innerHeight - 12
        ? anchor.bottom + 8 : anchor.top - bounds.height - 8),
    });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (popup.current?.contains(document.activeElement)) button.current?.focus();
      close();
    };
    const outside = (event: Event) => {
      if (event.target instanceof Node && (button.current?.contains(event.target) || popup.current?.contains(event.target))) return;
      close();
    };
    document.addEventListener("keydown", escape, true);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", outside, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("keydown", escape, true);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return <span className="diff-explanation-anchor">
    <button ref={button} className="diff-explanation-bubble" type="button"
      aria-label={explanations.length === 1 ? `Explanation: ${explanationLocation(explanations[0]).toLowerCase()}` : `${explanations.length} explanations for this line`}
      aria-haspopup="dialog" aria-controls={open ? id : undefined} aria-expanded={open}
      onPointerEnter={show} onPointerLeave={deferClose} onFocus={show}
      onBlur={blur} onKeyDown={(event) => {
        const link = popup.current?.querySelector<HTMLAnchorElement>("a");
        if (event.key === "Tab" && !event.shiftKey && link) { event.preventDefault(); link.focus(); }
      }} onClick={(event) => { event.stopPropagation(); show(); }}>
      <MessageCircle size={15} aria-hidden="true" />
      {explanations.length > 1 && <span className="diff-explanation-count">{explanations.length}</span>}
    </button>
    {open && createPortal(<div id={id} ref={popup} role="dialog" aria-label="Diff explanation" className="diff-explanation-popup"
      style={{ ...position, visibility: position ? "visible" : "hidden" }}
      onPointerEnter={cancelClose} onPointerLeave={deferClose} onFocus={cancelClose} onBlur={blur}
      onKeyDown={(event) => {
        if (event.key === "Tab" && event.shiftKey && event.target === popup.current?.querySelector("a")) {
          event.preventDefault(); button.current?.focus();
        }
      }}>
      {explanations.map((note, index) => <div className="diff-explanation-text" key={index}>
        <div className="diff-explanation-location">Explanation · {explanationLocation(note)}</div>
        <p><ExplanationText text={note.text} /></p>
      </div>)}
    </div>, document.body)}
  </span>;
}
