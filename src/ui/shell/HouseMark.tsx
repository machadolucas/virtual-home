import { cn } from "../cn";

/**
 * The app mark: a gable and a floor line, drawn as strokes so it reads as a
 * drafted elevation rather than a filled "home" pictogram. Same geometry as
 * `public/icons/house.svg` and the favicon.
 *
 * `className` replaces the default size rather than being appended to it: two
 * `size-*` utilities in one class list would be resolved by stylesheet order,
 * not by which one the caller wrote.
 */
export function HouseMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={cn("shrink-0", className ?? "size-6")}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* roof + walls */}
      <path d="M3 11.2 12 4l9 7.2" />
      <path d="M5.4 10v9.6h13.2V10" />
      {/* floor line */}
      <path d="M2.4 19.6h19.2" />
      {/* door */}
      <path d="M10.2 19.6v-5.2h3.6v5.2" />
    </svg>
  );
}
