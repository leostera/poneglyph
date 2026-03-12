import { type InputHTMLAttributes, forwardRef } from "react";

import { cn } from "./utils";

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, ...props }, ref) {
    return <input className={cn("pg-input", className)} ref={ref} {...props} />;
  },
);
