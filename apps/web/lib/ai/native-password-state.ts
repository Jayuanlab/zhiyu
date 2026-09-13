// Password responses map - stores pending password requests
export const passwordResponses = new Map<
  string,
  {
    ownerId: string;
    command: string;
    cwd?: string;
    expiresAt: number;
    resolve?: (
      result: {
        password: string;
        stdout?: string;
        stderr?: string;
        exitCode?: number;
      } | null,
    ) => void;
    reject?: (error: Error) => void;
  }
>();

export function registerPasswordRequest(id: string, ownerId: string, command: string, cwd?: string) {
  const pending = { ownerId, command, cwd, expiresAt: Date.now() + 300_000 };
  passwordResponses.set(id, pending);
  const timer = setTimeout(() => {
    if (passwordResponses.get(id) === pending) passwordResponses.delete(id);
  }, 300_000);
  timer.unref?.();
}

export function takePasswordRequest(id: string, ownerId: string) {
  const pending = passwordResponses.get(id);
  if (!pending || pending.ownerId !== ownerId) return null;
  passwordResponses.delete(id); // Consume before execution: retries cannot execute twice.
  return pending.expiresAt > Date.now() ? pending : null;
}



// Patterns that indicate sudo password is required
const SUDO_PASSWORD_PATTERNS = [
  /\[sudo\] password for .+:/,
  /^password:.*$/m,
  /sudo: \[sudo\] password for/,
  /sudo: a password is required/,
];

export function detectSudoPasswordPrompt(output: string): boolean {
  return SUDO_PASSWORD_PATTERNS.some((pattern) => pattern.test(output));
}

// Transform sudo command to accept password from stdin
export function transformSudoCommand(command: string): string {
  // Match sudo at the beginning of a command (with possible leading whitespace)
  // and optionally capture any arguments that follow
  return command.replace(
    /(\s*)sudo(\s+)/g,
    (_, leadingSpace, trailingSpace) => {
      return `${leadingSpace}sudo -S -p ''${trailingSpace}`;
    },
  );
}

