import { getPlatform } from "@/actions/app";
import { closeWindow, maximizeWindow, minimizeWindow } from "@/actions/window";
import { type ReactNode, useEffect, useState } from "react";

interface DragWindowRegionProps {
  title?: ReactNode;
}

export default function DragWindowRegion({ title }: DragWindowRegionProps) {
  const [platform, setPlatform] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    getPlatform()
      .then((value) => {
        if (active) {
          setPlatform(value);
        }
      })
      .catch((error) => {
        console.error("Failed to detect platform", error);
      });

    return () => {
      active = false;
    };
  }, []);

  const isMacOS = platform === "darwin";

  if (isMacOS) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-50 flex items-stretch justify-between">
      <div className="draglayer w-full">
        {title ? (
          <div className="flex select-none whitespace-nowrap px-3 py-2 text-gray-400 text-xs">
            {title}
          </div>
        ) : null}
      </div>

      <div className="pointer-events-auto flex">
        <WindowButtons />
      </div>
    </div>
  );
}

function WindowButtons() {
  return (
    <>
      <button
        className="p-2 hover:bg-slate-300"
        onClick={minimizeWindow}
        title="Minimize"
        type="button"
      >
        <svg aria-hidden="true" height="12" role="img" viewBox="0 0 12 12" width="12">
          <rect fill="currentColor" height="1" width="10" x="1" y="6" />
        </svg>
      </button>
      <button
        className="p-2 hover:bg-slate-300"
        onClick={maximizeWindow}
        title="Maximize"
        type="button"
      >
        <svg aria-hidden="true" height="12" role="img" viewBox="0 0 12 12" width="12">
          <rect fill="none" height="9" stroke="currentColor" width="9" x="1.5" y="1.5" />
        </svg>
      </button>
      <button className="p-2 hover:bg-red-300" onClick={closeWindow} title="Close" type="button">
        <svg aria-hidden="true" height="12" role="img" viewBox="0 0 12 12" width="12">
          <polygon
            fill="currentColor"
            fillRule="evenodd"
            points="11 1.576 6.583 6 11 10.424 10.424 11 6 6.583 1.576 11 1 10.424 5.417 6 1 1.576 1.576 1 6 5.417 10.424 1"
          />
        </svg>
      </button>
    </>
  );
}
