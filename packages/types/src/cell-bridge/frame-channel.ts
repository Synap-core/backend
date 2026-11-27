/**
 * The reply channel between a host and the document running in its frame.
 *
 * Why it exists (security review H1, 27 Nov 2026). A host used to answer a
 * frame with `frame.contentWindow.postMessage(answer, "*")`. The
 * `contentWindow` proxy outlives the document: a page that navigated its own
 * frame (a sandbox without `allow-top-navigation` still lets a frame navigate
 * ITSELF) kept receiving the answers meant for the page, at whatever origin it
 * moved to. The incoming check (`origin === "null"`) shuts the door to the new
 * document's questions, not to the old document's answers.
 *
 * So answers never go to the window. The document hands its host a
 * `MessagePort` when it starts:
 *
 *   frame → host   `synap:hello`, transferring one end of a MessageChannel
 *                  (from THIS frame's window, at the opaque origin "null")
 *   host  → frame  `synap:channel:ready` on that port, then every answer and
 *                  every push (`postToFrame`) on that port only
 *
 * A port belongs to the document that made it: once that document is gone
 * (navigated, reloaded), nothing posted to the port reaches anyone, and the
 * new document holds no port of ours. A new opaque-origin document of our own
 * (a new srcdoc) says hello again and gets its own channel: the re-handshake.
 *
 * The frame makes the channel, not the host: the host never transfers a port
 * with targetOrigin "*", so there is no moment at which a port of ours could
 * land in a document that just replaced the one that asked.
 *
 * The frame half (`CELL_FRAME_CHANNEL_SCRIPT`) runs before every SDK and
 * re-dispatches what arrives on the port as a window `message` event from
 * `window.parent`: the SDKs (and any cell code that listens on `window`) keep
 * working unchanged. Requests still travel frame → host on `window.parent`,
 * checked by source and origin as before.
 *
 * Pure, like the rest of this leaf: the channel state is keyed by the frame's
 * window object, so every host instance of one frame (a host React re-creates)
 * shares it, and tests drive it with fake windows and fake ports.
 */

import type { CellBridgeTarget } from "./host.js";

/** Frame → host: "here is my port". */
export const FRAME_HELLO_TYPE = "synap:hello" as const;
/** Host → frame, on the port: "I answer on this port from now on". */
export const FRAME_CHANNEL_READY_TYPE = "synap:channel:ready" as const;

/** One end of a MessageChannel, as the host uses it. */
export interface CellBridgePort {
  postMessage(message: unknown): void;
}

/** The slice of a `MessageEvent` the channel reads. */
export interface FrameHelloEventLike {
  data: unknown;
  ports?: ReadonlyArray<unknown>;
}

/** Messages kept for a frame whose port has not arrived yet. */
export const FRAME_CHANNEL_MAX_QUEUED = 64;

interface ChannelState {
  port: CellBridgePort | null;
  queue: unknown[];
}

const channels = new WeakMap<object, ChannelState>();

function stateOf(frame: CellBridgeTarget): ChannelState {
  let state = channels.get(frame);
  if (!state) {
    state = { port: null, queue: [] };
    channels.set(frame, state);
  }
  return state;
}

function isPort(value: unknown): value is CellBridgePort {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { postMessage?: unknown }).postMessage === "function"
  );
}

function enqueue(state: ChannelState, message: unknown): void {
  state.queue.push(message);
  if (state.queue.length > FRAME_CHANNEL_MAX_QUEUED) state.queue.shift();
}

/** Whether a frame message is a hello (with or without a usable port). */
export function isFrameHello(data: unknown): boolean {
  return (
    !!data &&
    typeof data === "object" &&
    (data as { type?: unknown }).type === FRAME_HELLO_TYPE
  );
}

/**
 * A hello from `frame`: its port becomes the frame's channel (the latest
 * hello wins: a new document of ours says hello again), is told so, and gets
 * what was waiting for it. The CALLER has checked that the event comes from
 * this frame's window at the opaque origin "null". True when the message was
 * a hello (handled, even when it carried no port: nothing else reads it).
 */
export function acceptFrameHello(
  frame: CellBridgeTarget,
  event: FrameHelloEventLike
): boolean {
  if (!isFrameHello(event.data)) return false;
  const port = event.ports?.[0];
  if (!isPort(port)) return true;
  const state = stateOf(frame);
  state.port = port;
  port.postMessage({ type: FRAME_CHANNEL_READY_TYPE });
  for (const message of state.queue.splice(0)) port.postMessage(message);
  return true;
}

/**
 * Where the answer to a message `frame` just sent goes: the port the frame
 * holds NOW, captured before any read runs. A document that is replaced while
 * its read runs never hands its answer to the next one. With no port yet (the
 * host missed the first hello), the answer waits for the next hello.
 */
export function frameReplyTo(
  frame: CellBridgeTarget
): (message: unknown) => void {
  const port = stateOf(frame).port;
  if (port) return (message) => port.postMessage(message);
  return (message) => postToFrame(frame, message);
}

/**
 * A host's own push to the frame (an init, a theme, a slide, a change): on
 * the frame's current port, or kept until its hello arrives. Never on the
 * window.
 */
export function postToFrame(frame: CellBridgeTarget, message: unknown): void {
  const state = stateOf(frame);
  if (state.port) state.port.postMessage(message);
  else enqueue(state, message);
}

/**
 * A new document is about to replace the one in `frame` (the host set a new
 * `srcdoc` on the same iframe): forget the old document's port and what was
 * waiting for it, so the host's next pushes wait for the NEW document's hello
 * instead of going down a port that dies with the old one. Call it in the
 * same task as the DOM change (a layout effect), before the new document can
 * say hello. A new iframe element has a new window and needs no reset.
 */
export function resetFrameChannel(frame: CellBridgeTarget): void {
  channels.delete(frame);
}

/** How many times the frame says hello before it gives up on a host. */
const HELLO_TRIES = 20;
/** Between two hellos while no host answered. */
const HELLO_RETRY_MS = 250;

/**
 * The frame half, as a script string a host injects FIRST, before every SDK
 * (`cellFrameHeadBlock`, `buildCellModuleFrameSrcdoc`, synap-app's
 * generated-app srcdoc). It makes a MessageChannel, keeps one end, and posts
 * `synap:hello` with the other to `window.parent`; until the host says
 * `synap:channel:ready` it says hello again (a host that started listening a
 * moment late). What arrives on its port is re-dispatched as a window
 * `message` event from `window.parent`, so every SDK reads it as before.
 *
 * Plain ES5 in a string; it never contains a closing script tag (a test pins
 * that). It reads its globals through `window` so a test can run it against
 * a fake one.
 */
export const CELL_FRAME_CHANNEL_SCRIPT = `(function () {
  "use strict";
  if (window.__synapChannel) return;
  var parentWindow = window.parent;
  var Channel = window.MessageChannel;
  var Message = window.MessageEvent;
  if (!parentWindow || parentWindow === window || typeof Channel !== "function") return;
  window.__synapChannel = true;
  var ready = false;
  var tries = 0;
  function relay(event) {
    var data = event.data;
    if (data && data.type === ${JSON.stringify(FRAME_CHANNEL_READY_TYPE)}) {
      ready = true;
      return;
    }
    var copy;
    try {
      copy = new Message("message", { data: data, origin: "", source: parentWindow });
    } catch (err) {
      return;
    }
    window.dispatchEvent(copy);
  }
  function hello() {
    if (ready) return;
    var channel = new Channel();
    channel.port1.onmessage = relay;
    try {
      parentWindow.postMessage({ type: ${JSON.stringify(FRAME_HELLO_TYPE)} }, "*", [channel.port2]);
    } catch (err) {
      return;
    }
    tries += 1;
    if (tries < ${HELLO_TRIES}) window.setTimeout(hello, ${HELLO_RETRY_MS});
  }
  hello();
})();`;
