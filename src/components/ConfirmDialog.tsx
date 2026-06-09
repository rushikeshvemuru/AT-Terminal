import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useConfirmationStore } from "@/store/useConfirmationStore";

export function ConfirmDialog() {
  const request = useConfirmationStore((state) => state.request);
  const resolve = useConfirmationStore((state) => state.resolve);

  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => !open && resolve(false)}>
      <DialogContent className="max-w-sm border-zinc-800 bg-zinc-950 text-zinc-100">
        <DialogHeader>
          <DialogTitle className="text-base">{request?.title ?? "Confirm action"}</DialogTitle>
          <DialogDescription className="text-sm text-zinc-400">
            {request?.description}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            type="button"
            onClick={() => resolve(false)}
            className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
          >
            {request?.cancelLabel ?? "Cancel"}
          </button>
          <button
            type="button"
            onClick={() => resolve(true)}
            className={cn(
              "rounded px-3 py-1.5 text-sm font-medium transition-colors",
              request?.destructive
                ? "bg-red-600 text-white hover:bg-red-500"
                : request?.variant === "warning"
                  ? "bg-amber-500 text-zinc-950 hover:bg-amber-400"
                  : "bg-zinc-100 text-zinc-950 hover:bg-white",
            )}
          >
            {request?.confirmLabel ?? "Continue"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
