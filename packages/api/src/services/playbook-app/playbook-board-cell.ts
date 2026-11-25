/**
 * The GENERATED cell of a playbook's UI: a board of the playbook's work, drawn
 * from `flow.of` (the one read a board is drawn from, `CELL_BRIDGE_READ_OPS`).
 *
 * Parameterised by FACTS only: the playbook's id and the kind it works. Every
 * state, label, stage and card comes from `flow.of` at run time, so the cell
 * never names a status or a stage, and a lifecycle or a playbook edited after
 * approval is drawn as it is now:
 *
 *   - one column per declared state, in declared order, headed by the stage of
 *     THIS playbook that owns it (or the other flow that does, or none);
 *   - each column's count (exact) and stuck count, its first cards, and how
 *     many more there are; things in no declared state get a column of their
 *     own, never dropped;
 *   - an EMPTY flow ("nothing in this flow yet") and a FAILED read (the error,
 *     and Retry) are different screens, never one;
 *   - the one action is a governed write the bridge already has: move a card
 *     to its next main-path state (`mutate("update_entity")` on the
 *     lifecycle property `flow.of` names). The reply's status is shown as it
 *     is: moved, waiting for review, or not allowed. A role's flow offers no
 *     move (its status lives on the role, not on the record's property).
 *
 * The source is an ES module that default-exports a React component (the frame
 * mechanism), importing only `react` (host-provided). It reaches nothing but
 * the bridge: no fetch, no import from the network, no runtime `deps`
 * (`checkCellSource`). Styles use the host's `--synap-*` tokens only.
 */

/** Cards drawn per state; the count is always exact. */
export const PLAYBOOK_BOARD_CARDS_PER_STATE = 8;

/** The bridge read the board is drawn from. */
export const PLAYBOOK_BOARD_READ_OP = "flow.of";

export interface PlaybookBoardCellParams {
  /** The playbook whose stages head the columns. */
  playbookId: string;
  /** The kind (or role) it works: `flow.of`'s `profileSlug`. */
  profileSlug: string;
}

/** The whole source of a playbook's board cell. */
export function playbookBoardCellSource(
  params: PlaybookBoardCellParams
): string {
  const playbookId = JSON.stringify(params.playbookId);
  const profileSlug = JSON.stringify(params.profileSlug);
  const readOp = JSON.stringify(PLAYBOOK_BOARD_READ_OP);
  return `import React from "react";

// Facts this cell was made from. Everything else is read from ${readOp}.
const PLAYBOOK_ID = ${playbookId};
const PROFILE_SLUG = ${profileSlug};
const CARDS_PER_STATE = ${PLAYBOOK_BOARD_CARDS_PER_STATE};

const h = React.createElement;
const bridge = () => window.SynapWidget;

const STYLE = \`
.pb { font-family: var(--synap-font-body); color: var(--synap-color); padding: var(--synap-space-3); }
.pb-head { display: flex; align-items: baseline; gap: var(--synap-space-2); margin-bottom: var(--synap-space-3); flex-wrap: wrap; }
.pb-title { font-size: 1.05rem; font-weight: 600; }
.pb-sub { color: var(--synap-muted); font-size: var(--synap-text-sm); }
.pb-cols { display: flex; gap: var(--synap-space-3); overflow-x: auto; align-items: flex-start; }
.pb-col { flex: 0 0 15rem; border: 1px solid var(--synap-border); border-radius: var(--synap-radius-card); padding: var(--synap-space-2); }
.pb-col-mine { border-color: var(--synap-accent); }
.pb-col-head { display: flex; justify-content: space-between; gap: var(--synap-space-2); font-weight: 600; }
.pb-owner { color: var(--synap-muted); font-size: var(--synap-text-sm); margin: var(--synap-space-1) 0 var(--synap-space-2); }
.pb-card { display: block; width: 100%; text-align: left; border: 1px solid var(--synap-border); border-radius: var(--synap-radius-control); background: transparent; color: inherit; padding: var(--synap-space-2); margin-bottom: var(--synap-space-2); font: inherit; }
.pb-card-name { background: none; border: 0; padding: 0; color: inherit; font: inherit; cursor: pointer; text-align: left; text-decoration: underline; }
.pb-meta { color: var(--synap-muted); font-size: var(--synap-text-sm); }
.pb-stuck { color: var(--synap-danger); font-size: var(--synap-text-sm); }
.pb-move { margin-top: var(--synap-space-1); border: 1px solid var(--synap-border); border-radius: var(--synap-radius-control); background: transparent; color: inherit; font: inherit; font-size: var(--synap-text-sm); cursor: pointer; padding: var(--synap-space-1) var(--synap-space-2); }
.pb-more { color: var(--synap-muted); font-size: var(--synap-text-sm); }
.pb-failed { border: 1px solid var(--synap-danger); border-radius: var(--synap-radius-card); padding: var(--synap-space-3); }
.pb-empty { color: var(--synap-muted); margin-bottom: var(--synap-space-3); }
\`;

function readFlow() {
  return bridge().query(${readOp}, {
    profileSlug: PROFILE_SLUG,
    firstN: CARDS_PER_STATE,
  });
}

/** The stage of THIS playbook that owns a state, else the first other owner. */
function ownerOf(state) {
  const owners = Array.isArray(state.owners) ? state.owners : [];
  const mine = owners.find((o) => o && o.playbookId === PLAYBOOK_ID);
  return { mine: mine || null, other: mine ? null : owners[0] || null };
}

function sinceText(iso) {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const days = Math.floor((Date.now() - at) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "1 day" : days + " days";
}

function moveWords(status) {
  if (status === "approved") return "Moved";
  if (status === "proposed") return "Waiting for review";
  if (status === "denied") return "Not allowed";
  return "Not moved";
}

function Card(props) {
  const card = props.card;
  const canMove = props.canMove && card.next && card.facetId == null;
  return h(
    "div",
    { className: "pb-card" },
    h(
      "button",
      {
        type: "button",
        className: "pb-card-name",
        onClick: () => bridge().navigate({ entityId: card.id }),
      },
      card.name || "Untitled"
    ),
    h(
      "div",
      { className: "pb-meta" },
      sinceText(card.enteredAt || card.since),
      card.stuck ? h("span", { className: "pb-stuck" }, " · stuck") : null
    ),
    canMove
      ? h(
          "button",
          {
            type: "button",
            className: "pb-move",
            disabled: props.note === "Moving…",
            onClick: () => props.onMove(card),
          },
          "Move to " + card.next.label
        )
      : null,
    props.note ? h("div", { className: "pb-meta", role: "status" }, props.note) : null
  );
}

function Column(props) {
  const state = props.state;
  const owner = ownerOf(state);
  const cards = Array.isArray(state.cards) ? state.cards : [];
  const more = (state.count || 0) - cards.length;
  return h(
    "section",
    { className: owner.mine ? "pb-col pb-col-mine" : "pb-col", "aria-label": state.label },
    h(
      "div",
      { className: "pb-col-head" },
      h("span", null, state.label),
      h("span", null, String(state.count || 0))
    ),
    h(
      "div",
      { className: "pb-owner" },
      owner.mine
        ? owner.mine.stageName
        : owner.other
          ? owner.other.stageName + " · " + owner.other.playbookName
          : "No stage owns this"
    ),
    state.stuck ? h("div", { className: "pb-stuck" }, state.stuck + " stuck") : null,
    cards.map((card) =>
      h(Card, {
        key: card.id,
        card,
        canMove: props.canMove,
        note: props.notes[card.id],
        onMove: props.onMove,
      })
    ),
    more > 0 ? h("div", { className: "pb-more" }, "+" + more + " more") : null
  );
}

export default function PlaybookBoard() {
  const [view, setView] = React.useState({ phase: "loading" });
  const [notes, setNotes] = React.useState({});

  const load = React.useCallback(() => {
    return Promise.resolve()
      .then(readFlow)
      .then(
        (flow) => {
          // A failed read is a failure, never an empty board.
          if (!flow || typeof flow !== "object" || flow.error || !Array.isArray(flow.states)) {
            setView({
              phase: "failed",
              message: flow && flow.error ? String(flow.error) : "The flow could not be read.",
            });
            return;
          }
          setView({ phase: "ready", flow });
        },
        (err) =>
          setView({ phase: "failed", message: String((err && err.message) || err) })
      );
  }, []);

  React.useEffect(() => {
    load();
    const off =
      typeof bridge().subscribe === "function"
        ? bridge().subscribe("entity:changed", () => load())
        : null;
    return () => {
      if (typeof off === "function") off();
    };
  }, [load]);

  React.useEffect(() => {
    if (typeof bridge().resize === "function") bridge().resize(document.body.scrollHeight);
  });

  const onMove = (card) => {
    const flow = view.flow;
    if (!flow || !card.next) return;
    setNotes((n) => Object.assign({}, n, { [card.id]: "Moving…" }));
    // A governed write: the status door and governance decide, not this cell.
    bridge()
      .mutate("update_entity", { id: card.id, properties: { [flow.property]: card.next.to } })
      .then(
        (result) => {
          const status = result && result.status;
          setNotes((n) => Object.assign({}, n, { [card.id]: moveWords(status) }));
          if (status === "approved") load();
        },
        (err) =>
          setNotes((n) =>
            Object.assign({}, n, { [card.id]: "Not moved: " + String((err && err.message) || err) })
          )
      );
  };

  let body;
  if (view.phase === "loading") {
    body = h("p", { className: "pb-sub" }, "Loading…");
  } else if (view.phase === "failed") {
    body = h(
      "div",
      { className: "pb-failed", role: "alert" },
      h("p", null, "This board could not be read: " + view.message),
      h("button", { type: "button", className: "pb-move", onClick: () => load() }, "Retry")
    );
  } else {
    const flow = view.flow;
    const mine = (flow.flows || []).find((f) => f && f.id === PLAYBOOK_ID);
    const totals = flow.totals || { total: 0, live: 0, doneWindowed: 0 };
    const canMove = flow.profileKind === "kind";
    const states = flow.unclassified && flow.unclassified.count > 0
      ? flow.states.concat([
          {
            key: "__unclassified",
            label: "In no declared state",
            owners: [],
            count: flow.unclassified.count,
            stuck: null,
            cards: flow.unclassified.cards || [],
          },
        ])
      : flow.states;
    body = h(
      React.Fragment,
      null,
      h(
        "div",
        { className: "pb-head" },
        h("span", { className: "pb-title" }, mine ? mine.name : "This playbook's work"),
        h(
          "span",
          { className: "pb-sub" },
          totals.live + " in progress · " + totals.doneWindowed + " done in the last " +
            ((flow.window && flow.window.days) || 30) + " days"
        )
      ),
      totals.total === 0 ? h("p", { className: "pb-empty" }, "Nothing in this flow yet.") : null,
      h(
        "div",
        { className: "pb-cols" },
        states.map((state) =>
          h(Column, { key: state.key, state, canMove, notes, onMove })
        )
      )
    );
  }

  return h("div", { className: "pb" }, h("style", null, STYLE), body);
}
`;
}
