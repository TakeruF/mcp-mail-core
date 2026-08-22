export type MailErrorCode =
  | "ACCOUNT_NOT_FOUND" | "ACCOUNT_NOT_READY" | "AMBIGUOUS_ACCOUNT"
  | "CAPABILITY_UNSUPPORTED" | "INVALID_INPUT" | "INVALID_REFERENCE"
  | "INVALID_CURSOR" | "AUTHENTICATION_FAILED" | "REAUTHORIZATION_REQUIRED"
  | "RATE_LIMITED" | "PROVIDER_UNAVAILABLE" | "MESSAGE_NOT_FOUND" | "INTERNAL";

export class MailError extends Error {
  public constructor(
    public readonly code: MailErrorCode,
    message: string,
    public readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MailError";
  }
}

export function publicFailure(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof MailError) return { code: error.code, message: error.message, retryable: error.retryable };
  return { code: "INTERNAL", message: "The mail operation failed.", retryable: false };
}
