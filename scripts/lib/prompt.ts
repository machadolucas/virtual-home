/**
 * Terminal input for the admin CLI.
 *
 * A password must never reach the shell history, so there is no `--password <value>` flag anywhere
 * in `vh-admin`. It is either typed at a hidden prompt on a TTY, or piped in with
 * `--password-from-stdin` (for the installer and for tests). Anything else is refused.
 */
import readline from "node:readline/promises";

/** Ctrl-C: the conventional 128 + SIGINT exit status. */
const EXIT_INTERRUPTED = 130;

export class PromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptError";
  }
}

function requireTty(): void {
  if (!process.stdin.isTTY) {
    throw new PromptError(
      "stdin is not a terminal — pass --password-from-stdin to read the password from a pipe " +
        "(never pass a password as a command-line argument: argv is world-readable)",
    );
  }
}

/** A visible line of input (names, yes/no answers). */
export async function promptLine(question: string): Promise<string> {
  requireTty();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** `question [y/N]` — anything but `y`/`yes` is a no. */
export async function promptConfirm(question: string): Promise<boolean> {
  const answer = (await promptLine(`${question} [y/N] `)).toLowerCase();
  return answer === "y" || answer === "yes";
}

/**
 * Read a line with echo off: raw mode, collect until Return, print nothing at all (not even
 * asterisks — a shoulder-surfer should not learn the length either).
 */
export function promptHidden(question: string): Promise<string> {
  requireTty();
  const stdin = process.stdin;
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const wasRaw = stdin.isRaw;
    const wasPaused = stdin.isPaused();

    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.removeListener("error", onError);
      stdin.setRawMode(wasRaw);
      if (wasPaused) stdin.pause();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          // Ctrl-C. Leave the terminal usable, then die like any other interrupted command.
          cleanup();
          process.stdout.write("\n");
          process.exit(EXIT_INTERRUPTED);
        }
        if (ch === "\u0004") {
          // Ctrl-D on an empty line is end-of-input, not an empty password.
          cleanup();
          process.stdout.write("\n");
          reject(new PromptError("input ended before a password was entered"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (ch < " ") continue; // ignore the remaining control characters
        value += ch;
      }
    };

    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
    stdin.once("error", onError);
  });
}

/** Everything on stdin, minus one trailing newline. Used by `--password-from-stdin`. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

export interface PasswordOptions {
  /** `--password-from-stdin` was given: read the password from the pipe, no confirmation prompt. */
  fromStdin: boolean;
  /** Refuse anything shorter (mirrors `emailAndPassword.minPasswordLength`). */
  minLength: number;
}

/**
 * Obtain a new password: either the whole of stdin, or a hidden prompt asked twice.
 *
 * The repeat exists because a typo in a password nobody can see locks a household member out of
 * their own house until someone gets back to the machine.
 */
export async function readNewPassword(label: string, options: PasswordOptions): Promise<string> {
  if (options.fromStdin) {
    const value = await readStdin();
    if (value.length < options.minLength) {
      throw new PromptError(`password on stdin is shorter than ${options.minLength} characters`);
    }
    return value;
  }
  const first = await promptHidden(`${label} (min ${options.minLength} characters): `);
  if (first.length < options.minLength) {
    throw new PromptError(`password must be at least ${options.minLength} characters`);
  }
  const again = await promptHidden("Repeat: ");
  if (first !== again) throw new PromptError("the two passwords differ");
  return first;
}
