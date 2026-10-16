export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown failure';
}

export function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}
// Only deliberately authored validation messages cross the workspace CLI boundary.
// Filesystem, subprocess and JSON parser errors may contain private input content.
export class WorkspaceInputError extends Error {}
