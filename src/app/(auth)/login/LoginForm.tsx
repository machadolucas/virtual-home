"use client";

import { useEffect, useRef, useState } from "react";
import { FingerprintPattern, KeyRound, TriangleAlert } from "lucide-react";
import { authClient } from "@/server/auth/client";
import { Avatar, Button, Checkbox, Field, Input, cn, focusRing } from "@/ui";
import type { LoginHint } from "./hints";

export interface LoginFormProps {
  /** Household members to offer as avatar buttons; empty hides the row. */
  hints: readonly LoginHint[];
  /** Already validated by `safeNextPath` on the server. */
  next: string;
}

const GENERIC_ERROR = "Wrong username or password";
const RATE_LIMIT_ERROR = "Too many attempts, wait a minute";
/**
 * A blank field is not a wrong credential. Nothing was sent, so nothing was rejected, and telling
 * somebody their password is wrong when they have not typed one sends them to reset a password
 * that is fine.
 */
const MISSING_USERNAME = "Enter your username";
const MISSING_PASSWORD = "Enter your password";
/** One message for an unknown passkey, a deactivated account and a failed signature alike. */
const PASSKEY_REFUSED = "That passkey was not accepted. Use your password instead.";
const PASSKEY_CANCELLED = "Passkey sign-in was cancelled.";

/** `NotAllowedError` / abort codes the passkey client reports for a dismissed or aborted ceremony. */
function isCancelled(code: string | undefined): boolean {
  return code === "AUTH_CANCELLED" || code === "ERROR_CEREMONY_ABORTED" || code === "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY";
}

/**
 * Conditional UI: the browser offers saved passkeys inside the username field's autofill list.
 * Needs `autocomplete="… webauthn"` on an input that is in the DOM when the request starts.
 */
async function conditionalMediationAvailable(): Promise<boolean> {
  if (typeof window === "undefined" || typeof window.PublicKeyCredential === "undefined") return false;
  const probe = window.PublicKeyCredential.isConditionalMediationAvailable;
  if (typeof probe !== "function") return false;
  try {
    return await probe.call(window.PublicKeyCredential);
  } catch {
    return false;
  }
}

/** Which field the error belongs on. `null` when it is about the pair, not either one. */
type ErrorField = "username" | "password" | null;

export function LoginForm({ hints, next }: LoginFormProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `aria-invalid` used to go on both fields for every failure, so a wrong password marked the
  // username — which is exactly the field that was correct — as invalid.
  const [errorField, setErrorField] = useState<ErrorField>(null);
  // With hints on screen the username field is present but visually hidden;
  // this reveals it for an account that is not in the list.
  const [showUsername, setShowUsername] = useState(hints.length === 0);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const passwordRef = useRef<HTMLInputElement | null>(null);

  // Start the autofill (conditional) passkey request once. Picking a passkey from the username
  // field's suggestions resolves it; the explicit button below aborts it and starts a modal one
  // (the WebAuthn client allows one ceremony at a time). Failures here are silent — the user did
  // not ask for anything yet, and the password path is right there.
  useEffect(() => {
    let active = true;
    void (async () => {
      if (!(await conditionalMediationAvailable()) || !active) return;
      const result = await authClient.signIn.passkey({ autoFill: true });
      if (active && result.data) window.location.assign(next);
    })();
    return () => {
      active = false;
    };
  }, [next]);

  async function signInWithPasskey() {
    if (busy || passkeyBusy) return;
    setError(null);
    setErrorField(null);
    setPasskeyBusy(true);
    const result = await authClient.signIn.passkey();
    if (result.data) {
      // Same full navigation as the password path, for the same reason.
      window.location.assign(next);
      return;
    }
    setPasskeyBusy(false);
    const failure = result.error;
    if (failure) {
      if (failure.status === 429) setError(RATE_LIMIT_ERROR);
      else if (isCancelled("code" in failure ? failure.code : undefined)) setError(PASSKEY_CANCELLED);
      else setError(PASSKEY_REFUSED);
    }
  }

  function pick(hint: LoginHint) {
    setUsername(hint.username);
    setError(null);
    setErrorField(null);
    passwordRef.current?.focus();
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setErrorField(null);

    const trimmed = username.trim();
    // Nothing is sent when a field is empty, so nothing can have been rejected. Say which field is
    // missing and mark that one, rather than reporting a credential failure that never happened.
    if (trimmed === "") {
      setShowUsername(true);
      setError(MISSING_USERNAME);
      setErrorField("username");
      return;
    }
    if (password === "") {
      setError(MISSING_PASSWORD);
      setErrorField("password");
      passwordRef.current?.focus();
      return;
    }

    setBusy(true);
    const result = await authClient.signIn.username({
      username: trimmed,
      password,
      rememberMe: remember,
    });

    if (result.error) {
      setBusy(false);
      setPassword("");
      // One message for every failure cause; the rate limit is the single
      // exception, because "wrong password" and "locked out" need different
      // reactions from the user and telling them apart costs nothing.
      const rateLimited = result.error.status === 429;
      setError(rateLimited ? RATE_LIMIT_ERROR : GENERIC_ERROR);
      // The credential *pair* was refused; the server never says which half was wrong, and
      // guessing would both be a lie and leak which usernames exist. So the invalid marker goes on
      // the field being retyped, and on nothing else — and a rate limit is about neither field, so
      // it marks neither.
      setErrorField(rateLimited ? null : "password");
      passwordRef.current?.focus();
      return;
    }

    // A full navigation, not a client-side push: the session cookie was set by
    // the response above, and a hard load guarantees the proxy and every
    // server component see it on the very first request.
    window.location.assign(next);
  }

  const selected = hints.find((hint) => hint.username === username) ?? null;

  return (
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
      {hints.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p id="who" className="text-[0.8125rem] font-medium text-ink-2">
            Who is this?
          </p>
          <ul aria-labelledby="who" className="flex list-none flex-wrap gap-2">
            {hints.map((hint) => {
              const active = selected?.username === hint.username;
              return (
                <li key={hint.username} className="flex-1">
                  <button
                    type="button"
                    onClick={() => pick(hint)}
                    aria-pressed={active}
                    className={cn(
                      "flex min-h-touch w-full flex-col items-center gap-2 rounded-lg border px-3 py-3",
                      "transition-colors duration-100",
                      active
                        ? "border-accent bg-accent-soft"
                        : "border-line bg-surface hover:border-line-strong hover:bg-surface-2",
                      focusRing,
                    )}
                  >
                    <Avatar name={hint.name} color={hint.displayColor} size="lg" />
                    <span
                      className={cn(
                        "truncate text-sm",
                        active ? "font-semibold text-accent-text" : "font-medium text-ink",
                      )}
                    >
                      {hint.name}
                    </span>
                    {active ? <span className="sr-only">Selected</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/*
        The username input is always in the DOM — never `display: none` and
        never removed — so iOS Passwords and every other password manager can
        fill it and offer to save the pair after a successful sign-in.
      */}
      <div className={cn(showUsername ? "block" : "sr-only")}>
        <Field label="Username" hideLabel={!showUsername} id="vh-username">
          {({ id }) => (
            <Input
              id={id}
              name="username"
              type="text"
              // `webauthn` lets the browser list this site's passkeys in the autofill menu.
              autoComplete="username webauthn"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="next"
              inputSize="lg"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              aria-invalid={errorField === "username" || undefined}
              aria-describedby={errorField === "username" ? "vh-login-error" : undefined}
            />
          )}
        </Field>
      </div>

      <Field label="Password" id="vh-password">
        {({ id }) => (
          <Input
            ref={passwordRef}
            id={id}
            name="password"
            type="password"
            // Also here: with avatar hints the username field is visually hidden, so the password
            // field is the one people focus, and this is where the passkey suggestion must appear.
            autoComplete="current-password webauthn"
            enterKeyHint="go"
            inputSize="lg"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={errorField === "password" || undefined}
            aria-describedby={errorField === "password" ? "vh-login-error" : undefined}
            icon={<KeyRound aria-hidden="true" />}
          />
        )}
      </Field>

      <Checkbox
        id="vh-remember"
        checked={remember}
        onCheckedChange={(value) => setRemember(value === true)}
        label="Keep me signed in"
        hint="Stays signed in for 30 days of inactivity on this device."
      />

      {error ? (
        <p
          id="vh-login-error"
          role="alert"
          className="flex items-start gap-2 text-sm font-medium text-overdue"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}

      <Button type="submit" variant="primary" size="lg" loading={busy} disabled={passkeyBusy} fullWidth>
        {busy ? "Signing in…" : "Sign in"}
      </Button>

      <Button
        type="button"
        variant="secondary"
        size="lg"
        loading={passkeyBusy}
        disabled={busy}
        onClick={signInWithPasskey}
        icon={<FingerprintPattern aria-hidden="true" />}
        fullWidth
      >
        Sign in with passkey
      </Button>

      {hints.length > 0 && !showUsername ? (
        <button
          type="button"
          onClick={() => setShowUsername(true)}
          className={cn(
            "mx-auto min-h-6 rounded-xs text-xs font-medium text-ink-3 underline underline-offset-2",
            "hover:text-ink-2",
            focusRing,
          )}
        >
          Sign in as someone else
        </button>
      ) : null}
    </form>
  );
}
