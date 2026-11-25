/**
 * The pod's own shapes for one request, read from the generated API types
 * (`@synap-core/api-types`), never re-declared here: a field the pod adds or
 * renames reaches the console's types the moment the types are regenerated.
 */
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@synap-core/api-types";

type Out = inferRouterOutputs<AppRouter>;
type In = inferRouterInputs<AppRouter>;

/** `proposals.repairOptions`. */
export type RepairOptions = Out["proposals"]["repairOptions"];
/** What a proposal needs from the person, with their own vault keys (`repairOptions.setup`). */
export type ProposalRepairSetup = NonNullable<RepairOptions["setup"]>;
/** One setup row (`ProposalSetupParam`). */
export type ProposalSetupParam = ProposalRepairSetup["params"][number];
/** One of the person's vault secrets a secret row may take. */
export type SetupSecretChoice = ProposalRepairSetup["secretChoices"][number];
/** A proposal's setup as `proposals.get` carries it. */
export type ProposalSetup = NonNullable<Out["proposals"]["get"]["setup"]>;
/** What one setup row hands over (`proposals.repair` `setup`). */
export type SetupRepairEntry = NonNullable<
  In["proposals"]["repair"]["setup"]
>[string];

/** `focusSessions.provideSecretUse`. */
export type ProvideSecretUseRead = Out["focusSessions"]["provideSecretUse"];
export type ProvideSecretUse = Extract<
  ProvideSecretUseRead,
  { status: "ok" }
>["use"];

/** `signals.needsYou` and one of its rows. */
export type NeedsYouRead = Out["signals"]["needsYou"];
export type NeedsYouSignal = NeedsYouRead["rows"]["needs_you"][number];
