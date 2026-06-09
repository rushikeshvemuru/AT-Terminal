import { getCurrentWindow } from "@tauri-apps/api/window";

const WindowControls = () => {
  const handleMinimize = () => {
    getCurrentWindow().minimize().catch(console.error);
  };
  const handleToggleMaximize = () => {
    getCurrentWindow().toggleMaximize().catch(console.error);
  };
  const handleClose = () => {
    getCurrentWindow().close().catch(console.error);
  };

  return (
    <div className="flex h-full select-none">
      <button
        onClick={handleMinimize}
        className="flex h-full w-12 items-center justify-center text-zinc-400 transition-colors hover:bg-zinc-800"
        title="Minimize"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      <button
        onClick={handleToggleMaximize}
        className="flex h-full w-12 items-center justify-center text-zinc-400 transition-colors hover:bg-zinc-800"
        title="Maximize"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
        </svg>
      </button>
      <button
        onClick={handleClose}
        className="flex h-full w-12 items-center justify-center text-zinc-400 transition-colors hover:bg-red-600"
        title="Close"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
};

export default WindowControls;
