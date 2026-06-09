import { memo } from "react";

interface MatchHighlightProps {
  text: string;
  highlight: string;
  className?: string;
  highlightClassName?: string;
}

/**
 * Highlights matched substrings within text.
 * Case-insensitive matching, preserves original text casing.
 */
export const MatchHighlight = memo(function MatchHighlight({
  text,
  highlight,
  className = "",
  highlightClassName = "bg-zinc-700 text-zinc-100 rounded-sm px-0.5",
}: MatchHighlightProps) {
  if (!highlight.trim()) {
    return <span className={className}>{text}</span>;
  }

  const escaped = highlight.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escaped})`, "gi");
  const parts = text.split(regex);

  return (
    <span className={className}>
      {parts.map((part, i) =>
        part.toLowerCase() === highlight.toLowerCase() ? (
          <span key={i} className={highlightClassName}>
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  );
});
