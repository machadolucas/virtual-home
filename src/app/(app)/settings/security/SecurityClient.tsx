"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Laptop,
  LogOut,
  Monitor,
  Smartphone,
  Tablet,
  TriangleAlert,
} from "lucide-react";
import { authClient } from "@/server/auth/client";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Panel,
  cn,
  toasts,
} from "@/ui";
import type { DeviceLabel } from "./device";

export interface SessionRow {
  id: string;
  /** Better Auth revokes by token; this is the user's own session token. */
  token: string;
  device: DeviceLabel;
  userAgent: string | null;
  ipAddress: string | null;
  createdLabel: string;
  expiresLabel: string;
  current: boolean;
}

export type SessionListState =
  | { kind: "ok"; sessions: readonly SessionRow[] }
  | { kind: "not-fresh" }
  | { kind: "failed" };

const MIN_PASSWORD_LENGTH = 12;

const FORM_ICON = {
  phone: Smartphone,
  tablet: Tablet,
  desktop: Laptop,
  unknown: Monitor,
} as const;

export function SecurityClient({ list }: { list: SessionListState }) {
  return (
    <>
      <ChangePassword />
      <Sessions list={list} />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Password                                                                    */
/* -------------------------------------------------------------------------- */

function ChangePassword() {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [revokeOthers, setRevokeOthers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<"current" | "next" | "confirm" | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldError(null);

    if (next.length < MIN_PASSWORD_LENGTH) {
      setFieldError("next");
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (next !== confirm) {
      setFieldError("confirm");
      setError("The two new passwords do not match.");
      return;
    }
    if (next === current) {
      setFieldError("next");
      setError("The new password must differ from the current one.");
      return;
    }

    setBusy(true);
    const result = await authClient.changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: revokeOthers,
    });
    setBusy(false);

    if (result.error) {
      const status = result.error.status;
      if (status === 429) {
        setError("Too many attempts, wait a minute.");
      } else if (status === 400 || status === 401) {
        setFieldError("current");
        setError("Current password is wrong.");
      } else {
        setError(result.error.message ?? "Could not change the password.");
      }
      return;
    }

    setCurrent("");
    setNext("");
    setConfirm("");
    toasts.success(
      "Password changed",
      revokeOthers ? "Other devices were signed out." : "Other devices stay signed in.",
    );
    router.refresh();
  }

  return (
    <Panel
      title="Password"
      subtitle={`At least ${MIN_PASSWORD_LENGTH} characters. There is no self-service reset — recovery needs the server CLI.`}
    >
      <form onSubmit={submit} className="flex max-w-sm flex-col gap-4">
        <Field
          label="Current password"
          error={fieldError === "current" ? error : undefined}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              type="password"
              name="currentPassword"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              required
            />
          )}
        </Field>

        <Field
          label="New password"
          help={`${MIN_PASSWORD_LENGTH} characters or more. A passphrase beats a clever short one.`}
          error={fieldError === "next" ? error : undefined}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              type="password"
              name="newPassword"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              value={next}
              onChange={(event) => setNext(event.target.value)}
              required
            />
          )}
        </Field>

        <Field
          label="Repeat new password"
          error={fieldError === "confirm" ? error : undefined}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              type="password"
              name="confirmPassword"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              required
            />
          )}
        </Field>

        <Checkbox
          id="revoke-others"
          checked={revokeOthers}
          onCheckedChange={(value) => setRevokeOthers(value === true)}
          label="Sign out other devices"
          hint="Recommended if you are changing the password because it may have leaked."
        />

        {error && fieldError === null ? (
          <p className="flex items-start gap-2 text-sm font-medium text-overdue">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}

        <div>
          <Button type="submit" variant="primary" loading={busy}>
            Change password
          </Button>
        </div>
      </form>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

function Sessions({ list }: { list: SessionListState }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  async function revoke(row: SessionRow) {
    setPending(row.id);
    const result = await authClient.revokeSession({ token: row.token });
    setPending(null);
    if (result.error) {
      toasts.error("Could not sign that device out", result.error.message ?? undefined);
      return;
    }
    toasts.success("Device signed out", row.device.label);
    router.refresh();
  }

  async function revokeOthers() {
    setBulkBusy(true);
    const result = await authClient.revokeOtherSessions();
    setBulkBusy(false);
    if (result.error) {
      toasts.error("Could not sign the other devices out", result.error.message ?? undefined);
      return;
    }
    toasts.success("Other devices signed out", "This device stays signed in.");
    router.refresh();
  }

  if (list.kind === "not-fresh") {
    return (
      <Panel title="Signed-in devices">
        <EmptyState
          icon={<LogOut />}
          title="Sign in again to see your devices"
          description="The device list is only released to a session that authenticated in the last few minutes, so a borrowed browser tab cannot enumerate where you are signed in."
          bullets={[
            "Signing out and back in takes a moment and unlocks the list.",
            "You can still sign every other device out without the list — the button below does not need a fresh session.",
          ]}
          actions={
            <Button variant="danger" loading={bulkBusy} onClick={revokeOthers}>
              Sign out all other devices
            </Button>
          }
        />
      </Panel>
    );
  }

  if (list.kind === "failed") {
    return (
      <Panel title="Signed-in devices">
        <EmptyState
          icon={<TriangleAlert />}
          title="Could not read the device list"
          description="The session store did not answer. Nothing was changed. The system page shows whether the database is healthy."
          actions={
            <Button variant="danger" loading={bulkBusy} onClick={revokeOthers}>
              Sign out all other devices
            </Button>
          }
        />
      </Panel>
    );
  }

  const others = list.sessions.filter((row) => !row.current);

  return (
    <Panel
      title="Signed-in devices"
      subtitle="Every active session for your account. Revoking one takes effect within a minute."
      actions={
        others.length > 0 ? (
          <Button variant="danger" size="sm" loading={bulkBusy} onClick={revokeOthers}>
            Sign out others
          </Button>
        ) : null
      }
      flush
    >
      <ul className="flex list-none flex-col">
        {list.sessions.map((row) => {
          const Icon = FORM_ICON[row.device.form];
          return (
            <li
              key={row.id}
              className={cn(
                "flex flex-wrap items-start gap-3 border-b border-line px-4 py-3 last:border-b-0",
                row.current && "bg-accent-soft/40",
              )}
            >
              <span
                aria-hidden="true"
                className="grid size-8 shrink-0 place-items-center rounded-md border border-line bg-surface-2 text-ink-3 [&_svg]:size-4"
              >
                <Icon />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-ink">{row.device.label}</span>
                  {row.current ? <Badge tone="accent">This device</Badge> : null}
                </div>
                <p className="vh-tnum mt-0.5 text-xs leading-5 text-ink-3">
                  {row.ipAddress ? `${row.ipAddress} · ` : ""}
                  signed in {row.createdLabel} · expires {row.expiresLabel}
                </p>
                {row.userAgent ? (
                  <p className="mt-1 truncate font-mono text-[0.6875rem] leading-4 text-ink-3">
                    {row.userAgent}
                  </p>
                ) : null}
              </div>
              {row.current ? (
                <span className="text-xs text-ink-3">Use “Sign out” in the account menu</span>
              ) : (
                <Button
                  variant="danger"
                  size="sm"
                  loading={pending === row.id}
                  onClick={() => revoke(row)}
                >
                  Sign out
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
