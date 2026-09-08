/**
 * The virtual-home design system.
 *
 * Import primitives from `@/ui`; the application shell lives under
 * `@/ui/shell` and is imported directly by `src/app/(app)/layout.tsx`.
 *
 * Conventions every primitive here follows:
 *  - `className` passthrough, appended last so callers can override.
 *  - Visible focus (`focusRing` / `focusRingInset`), never a bare outline-none.
 *  - Interactive boxes are >= 24 px, and >= 44 px wherever a finger is likely.
 *  - Colour never carries meaning alone: status has glyphs, selection has a
 *    rule, the active tab has weight.
 *  - No continuous animation; every transition is one-shot and short, and
 *    `prefers-reduced-motion` collapses all of them (see globals.css).
 */

/* helpers */
export { cn, focusRing, focusRingInset, hitArea, touchArea } from "./cn";
export type { ClassValue } from "./cn";
export {
  STATUS_KINDS,
  STATUS_URGENCY,
  CONNECTION_STATES,
  statusMeta,
  isStatusKind,
  toStatusKind,
  compareStatusUrgency,
  connectionMeta,
  connectionStateOf,
  isConnectionState,
  toConnectionState,
} from "./status";
export type {
  StatusKind,
  StatusIcon,
  StatusMeta,
  ConnectionState,
  ConnectionMeta,
  IntegrationStateName,
} from "./status";

/* controls */
export { Button, buttonClasses } from "./Button";
export type { ButtonProps, ButtonVariant, ButtonSize, ButtonClassOptions } from "./Button";
export { IconButton } from "./IconButton";
export type { IconButtonProps, IconButtonSize } from "./IconButton";
export { Spinner } from "./Spinner";

/* form fields */
export { Input, fieldSurface } from "./Input";
export type { InputProps, InputSize } from "./Input";
export { Textarea } from "./Textarea";
export type { TextareaProps } from "./Textarea";
export { Field } from "./Field";
export type { FieldProps, FieldRenderArgs } from "./Field";
export { Select } from "./Select";
export type { SelectProps, SelectOption } from "./Select";
export { Checkbox } from "./Checkbox";
export type { CheckboxProps } from "./Checkbox";
export { Switch } from "./Switch";
export type { SwitchProps } from "./Switch";
export { RadioGroup } from "./RadioGroup";
export type { RadioGroupProps, RadioOption } from "./RadioGroup";
export { SegmentedControl } from "./SegmentedControl";
export type { SegmentedControlProps, SegmentedItem } from "./SegmentedControl";

/* overlays */
export { Dialog, DialogClose, dialogOverlay } from "./Dialog";
export type { DialogProps } from "./Dialog";
export { Sheet, SheetClose } from "./Sheet";
export type { SheetProps, SheetSide } from "./Sheet";
export { Popover, PopoverClose } from "./Popover";
export type { PopoverProps } from "./Popover";
export { Tooltip, TooltipProvider } from "./Tooltip";
export type { TooltipProps } from "./Tooltip";

/* navigation & structure */
export { Tabs, TabsPanel } from "./Tabs";
export type { TabsProps, TabItem } from "./Tabs";
export { Breadcrumb } from "./Breadcrumb";
export type { BreadcrumbProps, Crumb } from "./Breadcrumb";
export { Panel } from "./Panel";
export type { PanelProps } from "./Panel";

/* display */
export { Badge, StatusBadge, StatusDot } from "./Badge";
export type { BadgeProps, BadgeTone, StatusDotProps } from "./Badge";
export { ConnectionPill } from "./ConnectionPill";
export type { ConnectionPillProps } from "./ConnectionPill";
export { Avatar, avatarColor, initials } from "./Avatar";
export type { AvatarProps, AvatarSize } from "./Avatar";
export { EmptyState } from "./EmptyState";
export type { EmptyStateProps } from "./EmptyState";
export { Skeleton } from "./Skeleton";
export type { SkeletonProps } from "./Skeleton";
export { Kbd } from "./Kbd";
export type { KbdProps } from "./Kbd";
export { ProgressBar } from "./ProgressBar";
export type { ProgressBarProps } from "./ProgressBar";
export { DataTable } from "./DataTable";
export type { DataTableProps, Column, SortState, SortDirection } from "./DataTable";

/* feedback */
export {
  ToastViewport,
  toast,
  toasts,
  dismissToast,
  dismissAllToasts,
  useToasts,
} from "./Toast";
export type { ToastInput, ToastItem, ToastTone } from "./Toast";
