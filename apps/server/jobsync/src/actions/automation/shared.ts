// Not a "use server" module: shared across src/actions/automation/ modules,
// so it must stay importable without becoming a callable server-action endpoint.

export function formatError(
  error: unknown,
  fallback: string,
): { success: false; message: string } {
  console.error(error, fallback);
  if (error instanceof Error) {
    return { success: false, message: error.message || fallback };
  }
  return { success: false, message: fallback };
}
