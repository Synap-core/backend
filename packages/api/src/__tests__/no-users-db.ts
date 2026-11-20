/**
 * A fake database's users read that finds no row: `ownerAndActor` /
 * `personOfOwner` then read the writer as standing for itself (a person).
 * Spread into a fake `db` whose suite is not about ownership.
 */
export const NO_USERS = {
  select: () => ({
    from: () => ({ where: () => ({ limit: async () => [] }) }),
  }),
};
