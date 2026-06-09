import { useEffect, useState } from "react";
import type { ResolvedPanelToolbarIconSource } from "@/lib/panelToolbarIcon";

interface ModuleToolbarIconProps {
  icon: ResolvedPanelToolbarIconSource;
}

type SvgMarkupCacheEntry =
  | { status: "pending"; promise: Promise<string | null> }
  | { status: "resolved"; markup: string | null };

const svgMarkupCache = new Map<string, SvgMarkupCacheEntry>();

function normalizeSvgMarkup(markup: string): string | null {
  if (!markup.includes("<svg")) {
    return null;
  }

  const withSizing = markup.replace(/<svg\b([^>]*)>/i, '<svg$1 width="100%" height="100%">');
  if (withSizing === markup) {
    return null;
  }

  return withSizing;
}

async function loadSvgMarkup(url: string): Promise<string | null> {
  const cached = svgMarkupCache.get(url);
  if (cached?.status === "resolved") {
    return cached.markup;
  }
  if (cached?.status === "pending") {
    return cached.promise;
  }

  const promise = fetch(url)
    .then(async (response) => {
      if (!response.ok) {
        return null;
      }

      const markup = normalizeSvgMarkup(await response.text());
      svgMarkupCache.set(url, { status: "resolved", markup });
      return markup;
    })
    .catch(() => {
      svgMarkupCache.set(url, { status: "resolved", markup: null });
      return null;
    });

  svgMarkupCache.set(url, { status: "pending", promise });
  return promise;
}

export function ModuleToolbarIcon({ icon }: ModuleToolbarIconProps) {
  const [inlineMarkup, setInlineMarkup] = useState<string | null>(() => {
    if (!icon.tintableSvg) {
      return null;
    }

    const cached = svgMarkupCache.get(icon.url);
    return cached?.status === "resolved" ? cached.markup : null;
  });
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const syncState = (markup: string | null, failed: boolean) => {
      queueMicrotask(() => {
        if (cancelled) {
          return;
        }
        setInlineMarkup(markup);
        setLoadFailed(failed);
      });
    };

    if (!icon.tintableSvg) {
      syncState(null, false);
      return () => {
        cancelled = true;
      };
    }

    const cached = svgMarkupCache.get(icon.url);
    if (cached?.status === "resolved") {
      syncState(cached.markup, cached.markup === null);
      return () => {
        cancelled = true;
      };
    }

    syncState(null, false);

    void loadSvgMarkup(icon.url).then((markup) => {
      if (cancelled) {
        return;
      }
      setInlineMarkup(markup);
      setLoadFailed(markup === null);
    });

    return () => {
      cancelled = true;
    };
  }, [icon.tintableSvg, icon.url]);

  if (icon.tintableSvg && inlineMarkup) {
    return (
      <span
        className="h-3.5 w-3.5 shrink-0 [&_svg]:block [&_svg]:h-full [&_svg]:w-full"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: inlineMarkup }}
      />
    );
  }

  if (icon.tintableSvg && !loadFailed) {
    return <span className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />;
  }

  return (
    <img src={icon.url} alt="" className="h-3.5 w-3.5 shrink-0 object-contain" aria-hidden="true" />
  );
}
