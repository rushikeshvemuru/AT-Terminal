import { useState } from "react";
import { FolderOpen } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { selectWorkspaceRoot } from "@/lib/workspaceRoots";

interface NewTabDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (rootDirectory: string) => void;
}

export const NewTabDialog = ({ open, onOpenChange, onCreate }: NewTabDialogProps) => {
  const [path, setPath] = useState("");

  const handleBrowse = async () => {
    const selected = await selectWorkspaceRoot("Select Root Directory");
    if (selected?.path) {
      setPath(selected.path);
    }
  };

  const handleCreate = () => {
    if (path.trim()) {
      onCreate(path.trim());
      setPath("");
      onOpenChange(false);
    }
  };

  const handleBack = () => {
    setPath("");
    onOpenChange(false);
  };

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) setPath("");
    onOpenChange(isOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-zinc-700 bg-zinc-900 text-zinc-100">
        <DialogHeader>
          <DialogTitle>New Tab</DialogTitle>
          <DialogDescription className="text-zinc-400">
            Select a root directory for the new tab.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 py-4">
          <input
            type="text"
            value={path}
            readOnly
            placeholder="Select a folder with the picker"
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 font-mono text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-500"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
            }}
          />
          <button
            onClick={handleBrowse}
            className="flex h-10 w-10 items-center justify-center rounded-md border border-zinc-700 bg-zinc-800 text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-100"
            title="Browse..."
          >
            <FolderOpen className="h-4 w-4" />
          </button>
        </div>
        <DialogFooter>
          <button
            onClick={handleBack}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 font-medium text-zinc-100 transition-colors hover:bg-zinc-700"
          >
            Back
          </button>
          <button
            onClick={handleCreate}
            disabled={!path.trim()}
            className="rounded-md bg-zinc-100 px-4 py-2 font-medium text-zinc-900 transition-colors hover:bg-zinc-200 disabled:opacity-50"
          >
            Create
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
