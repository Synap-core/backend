/**
 * A person's LinkedIn reach (CRM wave 2, S4a): the values of the system
 * `person` kind's `linkedinConnection`, written by the server only
 * (`api/src/services/connectors/linkedin-reach.ts`). ONE list: the seeder
 * writes `constraints.enum` from it and the writer types its values with it.
 *
 *  - `none`: not a connection, no request waiting;
 *  - `pending`: the owner's connection request waits for them;
 *  - `connected`: a 1st-degree connection (a message can be sent);
 *  - `ignored`: a request pending for more than 21 days, or one LinkedIn
 *    reports ignored.
 */
export const LINKEDIN_CONNECTION_VALUES = [
  "none",
  "pending",
  "connected",
  "ignored",
] as const;

export type LinkedinConnection = (typeof LINKEDIN_CONNECTION_VALUES)[number];
