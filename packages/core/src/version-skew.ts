const parts = (version: string) => version.split(/[.+-]/u).slice(0, 3).map(part => Number.parseInt(part, 10) || 0);

/** Orders two release versions by major, minor and patch. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return (x[index] ?? 0) - (y[index] ?? 0);
  return 0;
}
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
/** B5: shown on a member whose version differs from its hub's, and the refusal of new work on a member newer than its hub. */
export const versionSkewMessage = (member: string, hub: string): string => `This device runs ${member}. The hub runs ${hub}. Update this device with \`jevellan update\`.`;
