// ABOUTME: Reads the errno code (ENOENT, EXDEV, ...) from a caught error, checking its shape
// instead of asserting it, so a non-Error throw yields undefined rather than a crash.
export function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
