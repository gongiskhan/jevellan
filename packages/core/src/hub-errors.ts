/** A failed connection to shared hub authority, distinct from an HTTP rejection. */
export class HubUnavailable extends Error {
  readonly status = 503;
  constructor(name: string) { super(`Can't reach the hub (${name}). This will continue when it's back.`); }
}
