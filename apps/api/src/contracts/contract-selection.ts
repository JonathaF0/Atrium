export interface SelectableContract {
  id: string;
  status: string;
  startsAt: Date;
  endsAt: Date | null;
  createdAt: Date;
}

/** Active on `at`: status active, started, and not yet ended. */
export function isInForce(c: Pick<SelectableContract, "status" | "startsAt" | "endsAt">, at: Date): boolean {
  return (
    c.status === "active" &&
    c.startsAt.getTime() <= at.getTime() &&
    (c.endsAt === null || c.endsAt.getTime() > at.getTime())
  );
}

/**
 * Orders contracts in force from most to least specific: a fixed-term contract
 * before an open-ended one, then the shorter term, then the most recent start,
 * the most recently created, and finally the id, so the pick is deterministic.
 */
export function compareSpecificity(a: SelectableContract, b: SelectableContract): number {
  const aBounded = a.endsAt !== null;
  const bBounded = b.endsAt !== null;
  if (aBounded !== bBounded) return aBounded ? -1 : 1;
  if (a.endsAt && b.endsAt) {
    const lenA = a.endsAt.getTime() - a.startsAt.getTime();
    const lenB = b.endsAt.getTime() - b.startsAt.getTime();
    if (lenA !== lenB) return lenA - lenB;
  }
  if (a.startsAt.getTime() !== b.startsAt.getTime()) return b.startsAt.getTime() - a.startsAt.getTime();
  if (a.createdAt.getTime() !== b.createdAt.getTime()) return b.createdAt.getTime() - a.createdAt.getTime();
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function pickActiveContract<T extends SelectableContract>(contracts: T[], at: Date): T | null {
  const inForce = contracts.filter((c) => isInForce(c, at));
  inForce.sort(compareSpecificity);
  return inForce[0] ?? null;
}
