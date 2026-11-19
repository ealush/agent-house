// How a domain says no. Every bounded context (sessions, notes, jobs, review, …) refuses
// with its own error class, and every one of them extends DomainError: a status the
// caller is told, a message for people, and a stable `code` for clients to branch on.
// Domains never import the HTTP layer to say so; the edge turns any DomainError into a
// response with errorReply() below, and anything else into a 500 that's only logged.

export class DomainError extends Error {
  readonly status: number;
  /** A stable machine-readable reason, sent beside the message (clients branch on it, not on wording). */
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

export type ErrorReply = {
  status: number;
  body: { error: string; code?: string };
  /** The client may still be sending a body ah refused (too large, no room): close, don't drain it. */
  close: boolean;
  /** Unexpected: worth a line in the log. Never sent beyond "internal error". */
  internal: boolean;
};

/** What a failed request answers. Pure: the caller writes it. */
export function errorReply(err: unknown): ErrorReply {
  const status = err instanceof DomainError ? err.status : 500;
  const internal = status === 500;
  // A command's own complaint (git, tmux) says more than "Command failed: …".
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  const message = internal ? 'internal error' : (typeof stderr === 'string' && stderr.trim()) || (err as Error).message;
  const code = err instanceof DomainError && typeof err.code === 'string' ? err.code : undefined;
  return { status, body: { error: message, ...(code ? { code } : {}) }, close: status === 413 || status === 507, internal };
}
