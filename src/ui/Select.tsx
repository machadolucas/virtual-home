"use client";
import { useOverlayContainer } from "./OverlayContainer";

import { Popover as RadixPopover } from "radix-ui";
import { Check, ChevronDown, Search } from "lucide-react";
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn, focusRing, focusRingInset } from "./cn";
import type { InputSize } from "./Input";

const SIZE: Record<InputSize, string> = {
  sm: "h-11 px-2 text-[0.8125rem] md:h-8",
  md: "h-11 px-2.5 text-sm md:h-9",
  lg: "h-11 px-3 text-base",
};

export interface SelectOption {
  value: string;
  label: string;
  /** Secondary line inside the option (units, ids, hints). */
  hint?: string;
  disabled?: boolean;
}

export interface SelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  id?: string;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
  /** Accessible name when the select has no visible `<label>`. */
  ariaLabel?: string;
  selectSize?: InputSize;
  className?: string;
}

function searchableText(option: SelectOption): string {
  return `${option.label} ${option.hint ?? ""}`.normalize("NFKD").toLocaleLowerCase();
}

function nextFocusableFrom(trigger: HTMLButtonElement | null, backwards: boolean): void {
  if (!trigger) return;
  const scope = trigger.closest<HTMLElement>('[role="dialog"]') ?? document;
  const focusable = Array.from(
    scope.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter(
    (element) =>
      element.tabIndex >= 0 &&
      element.offsetParent !== null &&
      !element.closest('[aria-hidden="true"], [inert], [data-vh-select-popup]'),
  );
  const index = focusable.indexOf(trigger);
  focusable[index + (backwards ? -1 : 1)]?.focus();
}

/**
 * Searchable single-value combobox. Filtering and arrowing only change the
 * active option; Enter or a click explicitly commits it.
 */
export function Select({
  value,
  defaultValue,
  onValueChange,
  options,
  placeholder = "Choose…",
  id,
  name,
  disabled,
  required,
  invalid,
  describedBy,
  ariaLabel,
  selectSize = "md",
  className,
}: SelectProps) {
  const generatedId = useId();
  const listboxId = `${generatedId}-listbox`;
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
  const selectedValue = value === undefined ? uncontrolledValue : value;
  const selectedOption = options.find((option) => option.value === selectedValue);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeValue, setActiveValue] = useState<string>();
  const overlayContainer = useOverlayContainer();
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const skipRestoreFocusRef = useRef(false);

  const filteredOptions = useMemo(() => {
    const needle = query.trim().normalize("NFKD").toLocaleLowerCase();
    if (!needle) return options;
    return options.filter((option) => searchableText(option).includes(needle));
  }, [options, query]);

  const activeIndex = filteredOptions.findIndex(
    (option) => option.value === activeValue && !option.disabled,
  );
  const selectedIndex = filteredOptions.findIndex(
    (option) => option.value === selectedValue && !option.disabled,
  );
  const resolvedActiveIndex =
    activeIndex >= 0
      ? activeIndex
      : selectedIndex >= 0
        ? selectedIndex
        : filteredOptions.findIndex((option) => !option.disabled);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const choose = (option: SelectOption) => {
    if (option.disabled) return;
    if (value === undefined) setUncontrolledValue(option.value);
    onValueChange?.(option.value);
    close();
  };

  const moveActive = (direction: 1 | -1) => {
    if (filteredOptions.length === 0) return;
    let candidate = resolvedActiveIndex;
    for (let attempts = 0; attempts < filteredOptions.length; attempts += 1) {
      candidate = (candidate + direction + filteredOptions.length) % filteredOptions.length;
      if (!filteredOptions[candidate]?.disabled) {
        setActiveValue(filteredOptions[candidate]?.value);
        document
          .getElementById(`${listboxId}-option-${candidate}`)
          ?.scrollIntoView({ block: "nearest" });
        return;
      }
    }
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const direction = event.key === "Home" ? 1 : -1;
      let candidate = event.key === "Home" ? -1 : filteredOptions.length;
      while (true) {
        candidate += direction;
        const option = filteredOptions[candidate];
        if (!option) return;
        if (!option.disabled) {
          setActiveValue(option.value);
          document
            .getElementById(`${listboxId}-option-${candidate}`)
            ?.scrollIntoView({ block: "nearest" });
          return;
        }
      }
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const option = filteredOptions[resolvedActiveIndex];
      if (option) choose(option);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const backwards = event.shiftKey;
      skipRestoreFocusRef.current = true;
      close();
      requestAnimationFrame(() => nextFocusableFrom(triggerRef.current, backwards));
    }
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (
      event.key.length === 1 &&
      event.key !== " " &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      setQuery(event.key);
      setOpen(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
    }
  };

  return (
    <span className="relative block w-full">
      {name || required ? (
        <select
          aria-hidden="true"
          tabIndex={-1}
          name={name}
          value={selectedValue ?? ""}
          required={required}
          disabled={disabled}
          onChange={() => undefined}
          onInvalid={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
            setOpen(true);
          }}
          className="pointer-events-none absolute size-px opacity-0"
        >
          <option value="" />
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
      ) : null}

      <RadixPopover.Root
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setQuery("");
        }}
      >
        <RadixPopover.Trigger asChild>
          <button
            ref={triggerRef}
            id={id}
            type="button"
            role="combobox"
            aria-label={ariaLabel}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? listboxId : undefined}
            aria-required={required || undefined}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            disabled={disabled}
            onKeyDown={onTriggerKeyDown}
            className={cn(
              "inline-flex w-full items-center justify-between gap-2 rounded-sm border bg-surface-2 text-left text-ink",
              "border-line-strong transition-colors duration-100 hover:border-ink-3",
              !selectedOption && "text-ink-3",
              "disabled:cursor-not-allowed disabled:opacity-60",
              "aria-[invalid=true]:border-overdue aria-[invalid=true]:bg-overdue-soft",
              focusRing,
              SIZE[selectSize],
              className,
            )}
          >
            <span className="min-w-0 truncate">{selectedOption?.label ?? placeholder}</span>
            <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
          </button>
        </RadixPopover.Trigger>

        <RadixPopover.Portal container={overlayContainer}>
          <RadixPopover.Content
            ref={popupRef}
            data-vh-select-popup=""
            side="bottom"
            align="start"
            sideOffset={4}
            collisionPadding={8}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              searchRef.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              // Closing must not steal focus that the user explicitly moved elsewhere.
              const active = document.activeElement;
              const movedOutside = active instanceof HTMLElement && active !== document.body &&
                active !== triggerRef.current && !popupRef.current?.contains(active);
              if (skipRestoreFocusRef.current || movedOutside) event.preventDefault();
              skipRestoreFocusRef.current = false;
            }}
            className={cn(
              "z-50 flex max-h-[min(24rem,var(--radix-popover-content-available-height))]",
              options.some((option) => option.hint)
                ? "w-[max(var(--radix-popover-trigger-width),22rem)]"
                : "w-[var(--radix-popover-trigger-width)]",
              "max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-md border border-line",
              "bg-surface shadow-overlay data-[state=open]:animate-[vh-pop-in_120ms_var(--vh-ease-out)]",
            )}
          >
            <label className="relative block shrink-0 border-b border-line">
              <span className="sr-only">Search options</span>
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3"
              />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKeyDown}
                aria-controls={listboxId}
                aria-activedescendant={
                  resolvedActiveIndex >= 0
                    ? `${listboxId}-option-${resolvedActiveIndex}`
                    : undefined
                }
                autoComplete="off"
                placeholder="Search…"
                className={cn(
                  "h-11 w-full bg-surface-2 py-2 pl-9 pr-3 text-base text-ink md:h-9 md:text-sm",
                  "placeholder:text-ink-3",
                  focusRingInset,
                )}
              />
            </label>

            <div id={listboxId} role="listbox" aria-label="Options" className="overflow-y-auto p-1">
              {filteredOptions.length === 0 ? (
                <p role="status" className="px-3 py-4 text-center text-sm text-ink-3">
                  No matching options
                </p>
              ) : (
                filteredOptions.map((option, index) => {
                  const selected = option.value === selectedValue;
                  return (
                    <div
                      key={option.value}
                      id={`${listboxId}-option-${index}`}
                      role="option"
                      aria-selected={selected}
                      aria-disabled={option.disabled || undefined}
                      data-highlighted={index === resolvedActiveIndex ? "" : undefined}
                      onPointerMove={() => {
                        if (!option.disabled) setActiveValue(option.value);
                      }}
                      onPointerDown={(event) => {
                        if (event.pointerType === "mouse") event.preventDefault();
                      }}
                      onClick={() => choose(option)}
                      className={cn(
                        "relative flex min-h-11 cursor-default select-none items-start gap-2 rounded-sm",
                        "py-2 pl-8 pr-2.5 text-sm text-ink md:min-h-8 md:py-1.5",
                        "data-[highlighted]:bg-surface-3",
                        selected && "bg-accent-soft text-accent-text",
                        option.disabled && "pointer-events-none opacity-50",
                      )}
                    >
                      {selected ? (
                        <Check aria-hidden="true" className="absolute left-2 top-2.5 size-4 md:top-2" />
                      ) : null}
                      <span className="flex min-w-0 flex-col">
                        <span>{option.label}</span>
                        {option.hint ? (
                          <span className="text-xs text-ink-3 [overflow-wrap:anywhere]">{option.hint}</span>
                        ) : null}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </RadixPopover.Content>
        </RadixPopover.Portal>
      </RadixPopover.Root>
    </span>
  );
}
