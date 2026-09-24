"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import {
  Cloud,
  FingerprintPattern,
  Laptop,
  LogOut,
  Monitor,
  Pencil,
  Plus,
  Smartphone,
  Tablet,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { authClient } from "@/server/auth/client";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Panel,
  cn,
  toasts,
} from "@/ui";
import type { DeviceLabel } from "@/domain/deviceLabel";
import { safeNextPath } from "@/domain/nextPath";
import { PASSKEY_NAME_MAX, PASSKEY_REAUTH_REQUIRED } from "@/domain/passkeyProviders";

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

export interface PasskeyRow {
  id: string;
  /** Stored label (a default is assigned at registration). */
  name: string;
  /** From the AAGUID when known, e.g. "iCloud Keychain". */
  provider: string | null;
  /** `multiDevice`: synced by a password manager; otherwise bound to one authenticator. */
  synced: boolean;
  backedUp: boolean;
  createdLabel: string;
  /** Last passkey sign-in; null when none has been recorded (the column is newer than the passkeys). */
  lastUsedLabel: string | null;
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

export function SecurityClient({
  list,
  passkeys,
}: {
  list: SessionListState;
  passkeys: readonly PasskeyRow[];
}) {
  return (
    <>
      <ChangePassword />
      <Passkeys passkeys={passkeys} />
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
/* Passkeys                                                                    */
/* -------------------------------------------------------------------------- */

const noSubscribe = () => () => {};

/** WebAuthn exists in this browser. `false` during SSR, so the button renders disabled first. */
function useWebAuthnSupported(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => typeof window.PublicKeyCredential !== "undefined",
    () => false,
  );
}

function Passkeys({ passkeys }: { passkeys: readonly PasskeyRow[] }) {
  const router = useRouter();
  const supported = useWebAuthnSupported();
  const [adding, setAdding] = useState(false);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  async function signInAgain() {
    setSigningOut(true);
    await authClient.signOut();
    router.push(`/login?next=${encodeURIComponent(safeNextPath("/settings/security"))}` as Route);
  }

  async function add() {
    setAdding(true);
    setNeedsReauth(false);
    // No name: the server labels it from the authenticator (AAGUID) or this browser.
    const result = await authClient.passkey.addPasskey();
    setAdding(false);
    if (result.error) {
      // Browser-side failures carry a WebAuthn code; server refusals carry a status.
      const code = "code" in result.error ? result.error.code : undefined;
      if (code === PASSKEY_REAUTH_REQUIRED) {
        // The session is older than the registration window (a stolen cookie must not be able to
        // plant a passkey); a fresh sign-in reopens it.
        setNeedsReauth(true);
      } else if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") {
        toasts.error("Already registered", "This authenticator already holds a passkey for you here.");
      } else if (code === "ERROR_CEREMONY_ABORTED" || code === "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY") {
        toasts.info("No passkey added", "The request was cancelled.");
      } else if (result.error.status === 429) {
        toasts.error("Too many attempts", "Wait a minute and try again.");
      } else {
        toasts.error("Could not add a passkey", result.error.message ?? undefined);
      }
      return;
    }
    toasts.success("Passkey added", "Use it from the sign-in page on this device.");
    router.refresh();
  }

  return (
    <Panel
      title="Passkeys"
      subtitle="Sign in with Face ID, Touch ID or a security key instead of typing the password. A passkey only works on this site, so it never gets offered to a neighbouring app. The password keeps working."
      actions={
        <Button
          size="sm"
          icon={<Plus aria-hidden="true" />}
          loading={adding}
          disabled={!supported}
          onClick={add}
        >
          Add a passkey
        </Button>
      }
      flush
    >
      {needsReauth ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <p className="flex-1 text-sm font-medium text-ink">For security, sign in again to add a passkey.</p>
          <Button size="sm" variant="primary" loading={signingOut} onClick={signInAgain}>
            Sign in again
          </Button>
        </div>
      ) : null}
      {passkeys.length === 0 ? (
        <p className="px-4 py-3 text-sm leading-6 text-ink-2">
          {supported
            ? "No passkeys yet. Add one on each device you sign in from."
            : "This browser does not support passkeys. The password still works."}
        </p>
      ) : (
        <ul className="flex list-none flex-col" aria-label="Your passkeys">
          {passkeys.map((row) => (
            <PasskeyItem key={row.id} row={row} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function PasskeyItem({ row }: { row: PasskeyRow }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(row.name);
  const [saving, setSaving] = useState(false);
  const trimmed = name.trim();

  async function rename(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (trimmed === "" || trimmed === row.name) {
      setEditing(false);
      setName(row.name);
      return;
    }
    setSaving(true);
    const result = await authClient.passkey.updatePasskey({ id: row.id, name: trimmed });
    setSaving(false);
    if (result.error) {
      toasts.error("Could not rename the passkey", result.error.message ?? undefined);
      return;
    }
    setEditing(false);
    toasts.success("Passkey renamed", trimmed);
    router.refresh();
  }

  const details = [
    row.provider && row.provider !== row.name ? row.provider : null,
    row.synced ? "synced" : "this device only",
    row.synced && !row.backedUp ? "not backed up" : null,
    `added ${row.createdLabel}`,
    row.lastUsedLabel ? `last used ${row.lastUsedLabel}` : "no sign-in recorded yet",
  ].filter(Boolean);

  return (
    <li className="flex flex-wrap items-start gap-3 border-b border-line px-4 py-3 last:border-b-0">
      <span
        aria-hidden="true"
        className="grid size-8 shrink-0 place-items-center rounded-md border border-line bg-surface-2 text-ink-3 [&_svg]:size-4"
      >
        {row.synced ? <Cloud /> : <FingerprintPattern />}
      </span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <form onSubmit={rename} className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={`New name for ${row.name}`}
              value={name}
              maxLength={PASSKEY_NAME_MAX}
              onChange={(event) => setName(event.target.value)}
              className="w-56"
              autoFocus
            />
            <Button type="submit" size="sm" variant="primary" loading={saving} disabled={trimmed === ""}>
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setEditing(false);
                setName(row.name);
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <span className="text-sm font-semibold text-ink">{row.name}</span>
        )}
        <p className="vh-tnum mt-0.5 text-xs leading-5 text-ink-3">{details.join(" · ")}</p>
      </div>
      {editing ? null : (
        <span className="flex items-center gap-1">
          <IconButton
            label={`Rename ${row.name}`}
            variant="ghost"
            size="sm"
            icon={<Pencil aria-hidden="true" />}
            onClick={() => setEditing(true)}
          />
          <DeletePasskey row={row} />
        </span>
      )}
    </li>
  );
}

/** Behind a confirmation: the passkey must be registered again from its device to undo this. */
function DeletePasskey({ row }: { row: PasskeyRow }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    const result = await authClient.passkey.deletePasskey({ id: row.id });
    setBusy(false);
    if (result.error) {
      toasts.error("Could not delete the passkey", result.error.message ?? undefined);
      return;
    }
    setOpen(false);
    toasts.success("Passkey deleted", row.name);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <IconButton label={`Delete ${row.name}`} variant="ghost" size="sm" icon={<Trash2 aria-hidden="true" />} />
      }
      title={`Delete ${row.name}?`}
      description="It stops working for this site immediately."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={remove}>
            Delete passkey
          </Button>
        </>
      }
    >
      <p className="text-sm leading-6 text-ink-2">
        Devices already signed in stay signed in. Your password manager may still list the passkey;
        remove it there too so it is not offered again.
      </p>
    </Dialog>
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
                  // Destructive, and one per session row — "Sign out" alone does not say which
                  // device is about to lose its session.
                  aria-label={`Sign out ${row.device.label}, signed in ${row.createdLabel}`}
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
