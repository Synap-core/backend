/**
 * A request's FAMILY, drawn as its kind tile beside its title, on the row
 * and in the detail (one mark carries kind in both): a secret or connection
 * to hand over, a change to approve, a question, a step to approve (a go /
 * no-go), an access request.
 */
export type RequestFamily =
  "secret" | "change" | "question" | "step" | "access";
