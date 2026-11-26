/**
 * The two in-frame SDKs a MODULE frame gets as classic scripts, before its
 * module runs (`buildCellModuleFrameSrcdoc`, `module-frame.ts`). Moved verbatim:
 *
 *   - `SYNAP_WIDGET_SDK` (synap-app `packages/web/src/cell-runtime/
 *     iframe-protocol.ts`): `window.synap` — onInit, onUpdate, resize,
 *     navigate, toast, error, and v2 `query` / `mutate` / `context` /
 *     `openPanel` / `subscribe`, all over postMessage to `window.parent`.
 *     `window.SynapWidget` is the same object under its old name, a
 *     deprecated shim nobody is taught (founder, 23 Nov 2026: Cell).
 *   - `SYNAP_VIEW_SDK` (synap-app `packages/hooks/src/synap-bridge/
 *     view-sdk.inline.ts`): `window.SynapView` + `window.createSynapView`, the
 *     typed helpers (`listEntities`, `createEntity`, …) on the same bridge.
 *     Also registered in the frame's import map as `@synap/view-sdk`.
 *
 * Neither holds a token or a pod address: there is none to hold. Every read
 * and write is a message the HOST answers (`createCellFrameHost`,
 * `frame-host.ts`), under its own lens and the viewer's own session.
 *
 * Plain ES5 in strings; neither contains a closing script tag (a test pins it).
 */

export const SYNAP_WIDGET_SDK = `
(function() {
  var _onInit, _onUpdate, _lastInit;
  var post = function(msg) { window.parent.postMessage(msg, '*'); };

  window.addEventListener('message', function(e) {
    if (!e.data || typeof e.data.type !== 'string') return;
    if (e.data.type === 'synap:init') {
      _lastInit = e.data;
      if (typeof _onInit === 'function') _onInit(e.data.config, e.data.context);
    } else if (e.data.type === 'synap:update') {
      if (typeof _onUpdate === 'function') _onUpdate(e.data.config);
    } else if (e.data.type === 'synap:theme') {
      // The host flipped light/dark: the token layer switches on this marker.
      if (e.data.theme === 'light' || e.data.theme === 'dark') {
        document.documentElement.setAttribute('data-theme', e.data.theme);
      }
    }
  });

  // window.synap is the frame's one global (founder, 23 Nov 2026: the word
  // is Cell); window.SynapWidget is the SAME object under its old name, kept
  // so a cell written for it keeps working. Teach window.synap only.
  var api = {
    /** Register the init handler. Call this early — triggers synap:ready signal. */
    onInit: function(fn) {
      _onInit = fn;
      post({ type: 'synap:ready' });
      if (_lastInit) {
        var last = _lastInit;
        Promise.resolve().then(function() {
          if (_onInit) _onInit(last.config, last.context);
        });
      }
    },
    /** Register the config-update handler. */
    onUpdate: function(fn) { _onUpdate = fn; },
    /** Tell the host to resize the iframe to the given pixel height. */
    resize: function(h) { post({ type: 'synap:resize', height: h }); },
    /**
     * Navigate the host app to a workspace resource.
     * target: { type: "entity", id: "..." } | { type: "view", id: "..." }
     *       | { type: "channel", id: "..." } | { type: "document", id: "..." }
     *       | { type: "url", url: "https://..." }
     */
    navigate: function(target) { post({ type: 'synap:navigate', target: target }); },
    /** Show a toast notification in the host app. */
    toast: function(msg, level) { post({ type: 'synap:toast', message: msg, level: level || 'info' }); },
    /** Report an error (renders error state in host). */
    error: function(msg) { post({ type: 'synap:error', message: msg }); },
  };
  window.synap = api;
  /** @deprecated the old name of window.synap (same object). */
  window.SynapWidget = api;

  // v2: promise-based data API
  var _pending = {};
  var _pendingId = 0;

  window.addEventListener('message', function(e) {
    if (!e.data || typeof e.data.type !== 'string') return;
    if (e.data.type === 'synap:query:result' || e.data.type === 'synap:mutate:result' || e.data.type === 'synap:context:result') {
      var p = _pending[e.data.id];
      if (!p) return;
      delete _pending[e.data.id];
      if (e.data.error) { p.reject(new Error(e.data.error)); }
      else { p.resolve(e.data.type === 'synap:mutate:result' ? { status: e.data.status, data: e.data.data, proposalId: e.data.proposalId } : e.data.data); }
    }
  });

  api.query = function(operation, params) {
    return new Promise(function(resolve, reject) {
      var id = String(++_pendingId);
      _pending[id] = { resolve: resolve, reject: reject };
      post({ type: 'synap:query', id: id, operation: operation, params: params });
    });
  };

  api.mutate = function(operation, payload) {
    return new Promise(function(resolve, reject) {
      var id = String(++_pendingId);
      _pending[id] = { resolve: resolve, reject: reject };
      post({ type: 'synap:mutate', id: id, operation: operation, payload: payload });
    });
  };

  // v3: what the frame is about (anchor, space, project, goal, filters,
  // brand, locale, theme), answered by the host ('synap:context').
  api.context = function() {
    return new Promise(function(resolve, reject) {
      var id = String(++_pendingId);
      _pending[id] = { resolve: resolve, reject: reject };
      post({ type: 'synap:context', id: id });
    });
  };

  // v2: fire-and-forget shell action to open an entity/view/document in the side panel
  api.openPanel = function(panelType, resourceId) {
    var id = String(++_pendingId);
    post({ type: 'synap:open-panel', id: id, panelType: panelType, resourceId: resourceId });
  };

  // v2: real-time subscriptions via subscribe(event, handler) → unsubscribe fn
  // The host forwards entity-change socket events as 'synap:entity:changed' (convenience
  // alias) and generic 'synap:event' (for other named events). Both land here.
  var _subscriptions = [];
  function _dispatchEvent(eventName, data) {
    for (var i = 0; i < _subscriptions.length; i++) {
      if (_subscriptions[i].event === eventName) {
        try { _subscriptions[i].handler(data); } catch(e) { /* swallow */ }
      }
    }
  }

  window.addEventListener('message', function(e) {
    if (!e.data || typeof e.data.type !== 'string') return;
    if (e.data.type === 'synap:entity:changed') {
      // Convenience: expose as the canonical 'entity:changed' event name so
      // widget code can subscribe('entity:changed', fn) without knowing the
      // postMessage type string.
      _dispatchEvent('entity:changed', {
        entityId: e.data.entityId,
        patch: e.data.patch,
        profileSlug: e.data.profileSlug,
        changeType: e.data.changeType,
      });
    } else if (e.data.type === 'synap:event') {
      _dispatchEvent(e.data.event, e.data.data);
    }
  });

  api.subscribe = function(eventName, handler) {
    var entry = { event: eventName, handler: handler };
    _subscriptions.push(entry);
    return function() {
      var idx = _subscriptions.indexOf(entry);
      if (idx !== -1) _subscriptions.splice(idx, 1);
    };
  };
})();
`;

export const SYNAP_VIEW_SDK: string = `
(function() {
  'use strict';

  // ── Bridge transport (mirrors iframe.ts createFrameBridge) ──────────────────
  // Install window.__synap singleton so it can be shared with SYNAP_WIDGET_SDK.
  // If SYNAP_WIDGET_SDK already installed it (it doesn't, but guard anyway).
  if (!window.__synap) {
    var QUERY_TIMEOUT_MS = 10000;
    var _onInitFn = null;
    var _onUpdateFn = null;
    // Last synap:init context, replayed to a LATE onInit registration. ViewFrame
    // imports the user module from INSIDE its synap:init handler, so a frame's
    // own onReady is ALWAYS registered after init already fired — without this
    // replay the frame never learns its workspaceId / viewId / query.
    var _lastInitCtx = null;
    var _pending = {};
    var _pendingId = 0;
    var _bridgeSubs = [];

    var post = function(msg) { window.parent.postMessage(msg, '*'); };

    var bridgeHandler = function(e) {
      if (!e.data || typeof e.data.type !== 'string') return;
      var msg = e.data;
      switch (msg.type) {
        case 'synap:init': {
          var ctx = msg.context || {};
          var context = {
            workspaceId: ctx.workspaceId || '',
            // The space's name, host-stamped (a space package's title).
            workspaceName: typeof ctx.workspaceName === 'string' ? ctx.workspaceName : undefined,
            entityId: ctx.entityId,
            viewId: ctx.viewId,
            channelId: ctx.channelId,
            displayMode: ctx.displayMode,
            meta: ctx.meta,
            // Bound view's query hint — a renderer author reads context.query and
            // calls SynapView.listEntities(context.query) to pull its own data.
            query: ctx.query,
          };
          _lastInitCtx = context;
          if (typeof _onInitFn === 'function') _onInitFn(context);
          break;
        }
        case 'synap:update': {
          var partial = msg.context || msg.config || {};
          if (typeof _onUpdateFn === 'function') _onUpdateFn(partial);
          break;
        }
        case 'synap:query:result': {
          var entry = _pending[msg.id];
          if (!entry) break;
          delete _pending[msg.id];
          clearTimeout(entry.timer);
          if (msg.error) { entry.reject(new Error(msg.error)); }
          else { entry.resolve(msg.data); }
          break;
        }
        case 'synap:mutate:result': {
          var entry2 = _pending[msg.id];
          if (!entry2) break;
          delete _pending[msg.id];
          clearTimeout(entry2.timer);
          if (msg.error) { entry2.reject(new Error(msg.error)); }
          else { entry2.resolve({ status: msg.status, data: msg.data, proposalId: msg.proposalId }); }
          break;
        }
        case 'synap:event': {
          for (var i = 0; i < _bridgeSubs.length; i++) {
            if (_bridgeSubs[i].event === msg.event) {
              try { _bridgeSubs[i].handler(msg.data); } catch(err) { /* swallow */ }
            }
          }
          break;
        }
        // entity:changed is dispatched via synap.subscribe (wired in
        // SYNAP_WIDGET_SDK). We also mirror it through the bridge subscribe
        // channel so SynapView.subscribe('entity:changed', fn) works too.
        case 'synap:entity:changed': {
          var payload = {
            entityId: msg.entityId,
            patch: msg.patch,
            profileSlug: msg.profileSlug,
            changeType: msg.changeType,
          };
          for (var j = 0; j < _bridgeSubs.length; j++) {
            if (_bridgeSubs[j].event === 'entity:changed') {
              try { _bridgeSubs[j].handler(payload); } catch(err2) { /* swallow */ }
            }
          }
          break;
        }
      }
    };

    window.addEventListener('message', bridgeHandler);

    window.__synap = {
      onInit: function(fn) {
        _onInitFn = fn;
        post({ type: 'synap:ready' });
        // Replay a already-received init to this late registration (see _lastInitCtx).
        if (_lastInitCtx) {
          var replay = _lastInitCtx;
          Promise.resolve().then(function() { if (_onInitFn) _onInitFn(replay); });
        }
      },
      onUpdate: function(fn) { _onUpdateFn = fn; },
      query: function(operation, params) {
        return new Promise(function(resolve, reject) {
          var id = String(++_pendingId);
          var timer = setTimeout(function() {
            if (_pending[id]) { delete _pending[id]; reject(new Error('SynapBridge: query timed out')); }
          }, QUERY_TIMEOUT_MS);
          _pending[id] = { resolve: resolve, reject: reject, timer: timer };
          post({ type: 'synap:query', id: id, operation: operation, params: params || {} });
        });
      },
      mutate: function(operation, payload) {
        return new Promise(function(resolve, reject) {
          var id = String(++_pendingId);
          var timer = setTimeout(function() {
            if (_pending[id]) { delete _pending[id]; reject(new Error('SynapBridge: mutate timed out')); }
          }, QUERY_TIMEOUT_MS);
          _pending[id] = { resolve: resolve, reject: reject, timer: timer };
          post({ type: 'synap:mutate', id: id, operation: operation, payload: payload || {} });
        });
      },
      subscribe: function(event, handler) {
        var entry = { event: event, handler: handler };
        _bridgeSubs.push(entry);
        post({ type: 'synap:subscribe', event: event });
        return function() {
          var idx = _bridgeSubs.indexOf(entry);
          if (idx !== -1) _bridgeSubs.splice(idx, 1);
        };
      },
      navigate: function(target) { post({ type: 'synap:navigate', target: target }); },
      toast: function(message, level) { post({ type: 'synap:toast', message: message, level: level || 'info' }); },
      error: function(message) { post({ type: 'synap:error', message: message }); },
      resize: function(height) { post({ type: 'synap:resize', height: height }); },
      updateContext: function(meta) { post({ type: 'synap:context-update', meta: meta }); },
      openPanel: function(panelType, resourceId) {
        var id = String(++_pendingId);
        post({ type: 'synap:open-panel', id: id, panelType: panelType, resourceId: resourceId });
      },
      // Mirrors iframe.ts openSurface (fire-and-forget; the host acts or ignores).
      openSurface: function(surface) { post({ type: 'synap:surface:open', surface: surface }); },
      destroy: function() { window.removeEventListener('message', bridgeHandler); },
    };
  }

  // ── Typed view SDK (mirrors view-sdk.ts createSynapView) ────────────────────

  function toItems(raw) {
    if (Array.isArray(raw)) return { items: raw };
    if (raw && typeof raw === 'object' && Array.isArray(raw.items)) return { items: raw.items };
    return { items: [] };
  }

  function toMutationResult(raw) {
    var r = raw || {};
    return { status: r.status || 'denied', data: r.data, proposalId: r.proposalId };
  }

  function createSynapView(existingBridge) {
    var bridge = existingBridge || window.__synap;
    var context = { workspaceId: '' };
    var _readyFn = null;
    var _changeFn = null;
    var _wired = false;

    function ensureWired() {
      if (_wired) return;
      _wired = true;
      bridge.onInit(function(ctx) {
        Object.assign(context, ctx);
        if (_readyFn) _readyFn(context);
      });
      bridge.onUpdate(function(partial) {
        Object.assign(context, partial);
        if (_changeFn) _changeFn(context);
      });
    }

    return {
      context: context,
      onReady: function(fn) { _readyFn = fn; ensureWired(); },
      onContextChange: function(fn) { _changeFn = fn; ensureWired(); },
      listEntities: function(params) {
        return bridge.query('entities.list', params || {}).then(toItems);
      },
      getEntity: function(id) {
        return bridge.query('entities.get', { id: id }).then(function(r) { return r || null; });
      },
      listViews: function() {
        return bridge.query('views.list', {}).then(toItems);
      },
      listProfiles: function() {
        return bridge.query('profiles.list', {}).then(toItems);
      },
      createEntity: function(payload) {
        return bridge.mutate('create_entity', payload).then(toMutationResult);
      },
      updateEntity: function(payload) {
        return bridge.mutate('update_entity', payload).then(toMutationResult);
      },
      deleteEntity: function(payload) {
        return bridge.mutate('delete_entity', payload).then(toMutationResult);
      },
      createRelation: function(payload) {
        return bridge.mutate('create_relation', payload).then(toMutationResult);
      },
      mutate: function(intent, payload) {
        return bridge.mutate(intent, payload).then(toMutationResult);
      },
      openPanel: function(panelType, resourceId) { bridge.openPanel(panelType, resourceId); },
      navigate: function(target) { bridge.navigate(target); },
      toast: function(message, level) { bridge.toast(message, level); },
      updateContext: function(meta) { bridge.updateContext(meta); },
      subscribe: function(event, handler) { return bridge.subscribe(event, handler); },
      error: function(message) { bridge.error(message); },
      resize: function(height) { bridge.resize(height); },
      bridge: bridge,
      destroy: function() { if (bridge.destroy) bridge.destroy(); },
    };
  }

  // Expose globals so generated frame code can use either:
  //   window.SynapView.listEntities(...)         — imperative
  //   import { createSynapView } from '@synap/view-sdk'  — via importmap (see buildSrcdoc)
  window.SynapView = createSynapView(window.__synap);
  window.createSynapView = createSynapView;
})();
`;
