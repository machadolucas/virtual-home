"use client";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Rendered instead of the children when the subtree throws. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

/**
 * Wraps the 3D canvas **only**, so a WebGL or loader failure never takes the workspace chrome —
 * let alone the rest of the app — down with it. Today, Supplies and History keep working because
 * the viewer is a lazily-imported leaf behind this boundary.
 */
export class HouseErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
    console.error("[house] viewer subtree failed", error, info.componentStack);
  }

  private readonly reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div
        role="alert"
        className="flex h-full flex-col items-start justify-center gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-700"
      >
        <p className="font-medium text-neutral-900">The 3D view could not start.</p>
        <p className="max-w-prose text-neutral-600">
          Everything else on this page still works. {error.message}
        </p>
        <button
          type="button"
          onClick={this.reset}
          className="min-h-8 rounded-md border border-neutral-300 bg-white px-3 text-sm font-medium text-neutral-800 hover:bg-neutral-100"
        >
          Try again
        </button>
      </div>
    );
  }
}
