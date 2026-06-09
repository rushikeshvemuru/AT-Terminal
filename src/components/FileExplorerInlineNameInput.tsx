import { useEffect, useRef, useState } from "react";

export function FileExplorerInlineNameInput({
  initialValue,
  type,
  onSubmit,
  onCancel,
}: {
  initialValue?: string;
  type: "file" | "directory";
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue ?? "");
  const hasFocusedRef = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      const input = inputRef.current;
      if (input) {
        input.focus();
        const dotIndex = value.lastIndexOf(".");
        if (dotIndex > 0 && type === "file") {
          input.setSelectionRange(0, dotIndex);
        } else {
          input.select();
        }
      }
    }, 50);
    return () => clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFocus = () => {
    hasFocusedRef.current = true;
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onSubmit(value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  const handleBlur = () => {
    if (!hasFocusedRef.current) return;
    if (value.trim()) {
      onSubmit(value);
    } else {
      onCancel();
    }
  };

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onFocus={handleFocus}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      placeholder={type === "file" ? "filename.ext" : "folder name"}
      className="mx-1 h-5 w-full cursor-text rounded border border-zinc-600 bg-zinc-900 px-1 py-0 text-xs text-zinc-100 outline-none focus:border-zinc-400"
    />
  );
}
