/** Current in-game account identity, as recognized from the device. */
export type CurrentAccount = { name: string | null; id: string | null };

/**
 * Detects which game account is currently logged in on the device.
 * Managed dispatch is fail-closed: a null result blocks execution.
 */
export interface AccountProbe {
  currentAccount(): Promise<CurrentAccount | null>;
}

/**
 * Fail-closed probe used until a real recognition (OCR) implementation is
 * accepted on the device. It always reports "cannot determine", so managed
 * runs are never dispatched on an unverified account.
 */
export class NullAccountProbe implements AccountProbe {
  async currentAccount(): Promise<CurrentAccount | null> { return null; }
}

/**
 * Case-insensitive match of a stored account matcher against the recognized
 * player name or ID. Either field matching either direction is accepted.
 */
export function matchesAccount(matcher: string, account: CurrentAccount): boolean {
  if (!matcher || !account) return false;
  const m = matcher.trim().toLowerCase();
  if (!m) return false;
  const fields = [account.name, account.id]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map(v => v.toLowerCase());
  return fields.some(f => f.includes(m) || m.includes(f));
}
