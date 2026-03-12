import { type InputHTMLAttributes, forwardRef } from "react";

import { Input } from "../components/ui/input";
import { cn } from "./utils";

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, ...props }, ref) {
    return <Input className={cn("h-10 rounded-full text-sm", className)} ref={ref} {...props} />;
  },
);
