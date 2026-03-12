import { SearchIcon } from "lucide-react";
import type { PropsWithChildren, ReactNode } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Button } from "./Button";
import { cn } from "./utils";

type CommandDialogProps = PropsWithChildren<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inputRef?: React.Ref<HTMLInputElement>;
  query: string;
  onQueryChange: (value: string) => void;
  placeholder?: string;
  closeLabel?: ReactNode;
}>;

export function CommandDialog({
  children,
  closeLabel = "esc",
  inputRef,
  onOpenChange,
  onQueryChange,
  open,
  placeholder,
  query,
}: CommandDialogProps) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="top-[14vh] max-w-[680px] translate-y-0 gap-0 overflow-hidden border border-border/80 bg-black/95 p-0 shadow-2xl sm:max-w-[680px]"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Search Poneglyph</DialogTitle>
          <DialogDescription>Search entities, facts, transactions, and commands.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border/80 p-3">
          <label className="flex h-10 items-center gap-2 rounded-full border border-border/80 bg-muted/30 px-3">
            <SearchIcon className="size-4 text-muted-foreground" />
            <input
              className="w-full border-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={placeholder}
              ref={inputRef}
              value={query}
            />
          </label>
          <Button onClick={() => onOpenChange(false)} size="sm" tone="secondary">
            {closeLabel}
          </Button>
        </div>
        <div className="grid gap-1 p-2">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

type CommandItemProps = {
  title: string;
  meta: string;
  trailing?: ReactNode;
  onSelect?: () => void;
};

export function CommandItem({ meta, onSelect, title, trailing }: CommandItemProps) {
  return (
    <button
      className={cn(
        "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-2xl px-3 py-3 text-left text-sm transition-colors hover:bg-muted/60",
      )}
      onClick={onSelect}
      type="button"
    >
      <div>
        <strong className="block font-medium text-foreground">{title}</strong>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{meta}</p>
      </div>
      {trailing ? (
        <span className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          {trailing}
        </span>
      ) : null}
    </button>
  );
}
