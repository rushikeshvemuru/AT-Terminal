import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { OVERLAY_Z_INDEX } from "@/lib/overlayLayers";

const VIEWPORT_MARGIN = 8;

interface FloatingContextMenuProps {
  children: React.ReactNode;
  className?: string;
  onClose: () => void;
  x: number;
  y: number;
}

export function FloatingContextMenu({
  children,
  className,
  onClose,
  x,
  y,
}: FloatingContextMenuProps) {
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = React.useState(() => clampMenuPosition(x, y, 0, 0));

  const updatePosition = React.useCallback(() => {
    const bounds = menuRef.current?.getBoundingClientRect();
    setPosition(clampMenuPosition(x, y, bounds?.width ?? 0, bounds?.height ?? 0));
  }, [x, y]);

  React.useLayoutEffect(() => {
    updatePosition();
  }, [children, updatePosition]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("resize", updatePosition);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, updatePosition]);

  return createPortal(
    <div
      className="fixed inset-0"
      style={{
        zIndex: OVERLAY_Z_INDEX.floatingMenu,
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.button === 2) {
          return;
        }
        onClose();
      }}
    >
      <div
        ref={menuRef}
        role="menu"
        className={cn(
          "fixed min-w-[180px] overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 py-1 text-zinc-300 shadow-lg",
          className,
        )}
        style={{
          left: position.left,
          maxHeight: `calc(100vh - ${VIEWPORT_MARGIN * 2}px)`,
          top: position.top,
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function clampMenuPosition(x: number, y: number, width: number, height: number) {
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
  const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);

  return {
    left: Math.min(Math.max(x, VIEWPORT_MARGIN), maxLeft),
    top: Math.min(Math.max(y, VIEWPORT_MARGIN), maxTop),
  };
}
