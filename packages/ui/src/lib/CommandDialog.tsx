import * as Dialog from "@radix-ui/react-dialog";
import type { PropsWithChildren, ReactNode } from "react";

import { Button } from "./Button";
import { TextInput } from "./TextInput";
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
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="pg-command-overlay" />
        <Dialog.Content className="pg-command-content">
          <div className="pg-command-header">
            <TextInput
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={placeholder}
              ref={inputRef}
              value={query}
            />
            <Dialog.Close asChild>
              <Button size="sm" tone="secondary">
                {closeLabel}
              </Button>
            </Dialog.Close>
          </div>
          <div className="pg-command-list">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
    <button className={cn("pg-command-item")} onClick={onSelect} type="button">
      <div>
        <strong>{title}</strong>
        <p>{meta}</p>
      </div>
      {trailing ? <span>{trailing}</span> : null}
    </button>
  );
}
