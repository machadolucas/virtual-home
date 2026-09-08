import type { ComponentPropsWithRef } from "react";
import { cn } from "./cn";
import { fieldSurface } from "./Input";

export type TextareaProps = ComponentPropsWithRef<"textarea">;

export function Textarea({ className, rows = 4, ...rest }: TextareaProps) {
  return (
    <textarea
      rows={rows}
      className={cn(fieldSurface, "min-h-20 resize-y px-2.5 py-2 text-sm leading-6", className)}
      {...rest}
    />
  );
}
