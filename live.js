// Name: SmartTEAM Live
// ID: smartteamlive
// Description: Read real-time AI signals from a SmartTEAM WebSocket room (currently gestures).
// By: marianobat <https://scratch.mit.edu/users/marianobat/>
// License: MPL-2.0
// Manual testing:
// https://turbowarp.org/editor?extension=http://localhost:8000/marianobat/live.js&room=ST-XXXX&wsBase=wss://smartteam-gesture-bridge.marianobat.workers.dev/ws

(function (Scratch) {
  "use strict";

  if (!Scratch) return;

  const DEFAULT_WS_BASE =
    "wss://smartteam-gesture-bridge.marianobat.workers.dev/ws";

  // Backoff sequence (ms). Cap is handled by last value.
  const BACKOFF_MS = [1000, 2000, 3000, 5000];

  /**
   * Read a querystring param from a given search string ("?a=b") safely.
   */
  function getQueryParamFromSearch(search, name) {
    try {
      const params = new URLSearchParams(search || "");
      const v = params.get(name);
      return v == null ? "" : String(v);
    } catch (e) {
      return "";
    }
  }

  /**
   * Read a querystring param from current page (window.location.search).
   */
  function getQueryParam(name) {
    return getQueryParamFromSearch(window.location.search || "", name);
  }

  /**
   * Room can appear in search or sometimes in hash.
   * This function checks both.
   */
  function getRoomFromWindow() {
    const fromSearch = getQueryParamFromSearch(window.location.search, "room");
    if (fromSearch) return fromSearch;

    const h = window.location.hash || "";
    const qIndex = h.indexOf("?");
    if (qIndex !== -1) {
      const fromHashQuery = getQueryParamFromSearch(h.slice(qIndex), "room");
      if (fromHashQuery) return fromHashQuery;
    }
    if (h.startsWith("#")) {
      const fromHash = getQueryParamFromSearch(h.slice(1), "room");
      if (fromHash) return fromHash;
    }

    return "";
  }

  /**
   * Read a param from the extension script URL (document.currentScript.src).
   * This is a robust fallback if the editor URL params change after load.
   */
  function getParamFromCurrentScript(name) {
    try {
      const src =
        document.currentScript && document.currentScript.src
          ? document.currentScript.src
          : "";
      if (!src) return "";
      const u = new URL(src);
      const v = u.searchParams.get(name);
      return v == null ? "" : String(v);
    } catch (e) {
      return "";
    }
  }

  /**
   * Validate wsBase override:
   * Only allow ws:// or wss://. If invalid, return default.
   */
  function normalizeWsBase(maybeWsBase) {
    const raw = (maybeWsBase || "").trim();
    if (!raw) return DEFAULT_WS_BASE;
    try {
      const u = new URL(raw);
      if (u.protocol === "ws:" || u.protocol === "wss:") return u.toString();
      return DEFAULT_WS_BASE;
    } catch (e) {
      return DEFAULT_WS_BASE;
    }
  }

  /**
   * Normalize room string (backend expects ST-... style).
   */
  function normalizeRoom(room) {
    return String(room || "").trim();
  }

  /**
   * Safe parse JSON. Returns null on failure.
   */
  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  /**
   * Coerce to finite number.
   */
  function toFiniteNumber(x, fallback) {
    const n = Number(x);
    return Number.isFinite(n) ? n : fallback;
  }

  /**
   * Round to 2 decimals for reporting.
   */
  function round2(n) {
    const r = Math.round(n * 100) / 100;
    return Object.is(r, -0) ? 0 : r;
  }

  /**
   * Scratch.canFetch is designed around http/https permissions.
   * For ws/wss URLs, check permissions using an equivalent http/https URL.
   */
  function toCanFetchUrl(wsUrl) {
    try {
      const u = new URL(wsUrl);
      if (u.protocol === "wss:") u.protocol = "https:";
      else if (u.protocol === "ws:") u.protocol = "http:";
      return u.toString();
    } catch (e) {
      // If something is weird, just return empty so canFetch fails safe.
      return "";
    }
  }

  class SmartteamLiveExtension {
    constructor() {
      // Internal state
      this._connected = false;
      this._room = "";
      this._wsBase = DEFAULT_WS_BASE;
      this._gesture = "";
      this._confidence = 0;
      this._subscribers = 0;

      // WebSocket + reconnect handling
      this._ws = null;
      this._shouldReconnect = false;
      this._reconnectTimer = null;
      this._backoffIndex = 0;

      // Room probe (timing robustness)
      this._roomProbeTimer = null;

      // wsBase: from editor URL first, then from extension URL
      const wsBaseFromEditor = getQueryParam("wsBase");
      const wsBaseFromScript = getParamFromCurrentScript("wsBase");
      this._wsBase = normalizeWsBase(wsBaseFromEditor || wsBaseFromScript);

      // room: editor URL (search/hash), then extension URL
      const roomFromEditor = normalizeRoom(getRoomFromWindow());
      const roomFromScript = normalizeRoom(getParamFromCurrentScript("room"));
      const urlRoom = roomFromEditor || roomFromScript;

      if (urlRoom) {
        this.setRoomInternal(urlRoom, /*auto*/ true);
      } else {
        // If room not available yet, probe briefly (covers URL normalization timing).
        this._connected = false;
        this._startRoomProbe();
      }
    }

    getInfo() {
      return {
        id: "smartteamlive",
        name: Scratch.translate("SmartTEAM Live"),
        blocks: [
          {
            opcode: "getRoom",
            blockType: Scratch.BlockType.REPORTER,
            text: Scratch.translate("room"),
          },
          {
            opcode: "isConnected",
            blockType: Scratch.BlockType.BOOLEAN,
            text: Scratch.translate("connected?"),
          },
          {
            opcode: "getGesture",
            blockType: Scratch.BlockType.REPORTER,
            text: Scratch.translate("gesture"),
          },
          {
            opcode: "getConfidence",
            blockType: Scratch.BlockType.REPORTER,
            text: Scratch.translate("confidence"),
          },
          {
            opcode: "getSubscribers",
            blockType: Scratch.BlockType.REPORTER,
            text: Scratch.translate("subscribers"),
          },
          "---",
          {
            opcode: "setRoom",
            blockType: Scratch.BlockType.COMMAND,
            text: Scratch.translate("set room to [ROOM]"),
            arguments: {
              ROOM: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: Scratch.translate("ST-XXXXXXX"),
              },
            },
          },
          {
            opcode: "reconnect",
            blockType: Scratch.BlockType.COMMAND,
            text: Scratch.translate("reconnect"),
          },
          {
            opcode: "disconnect",
            blockType: Scratch.BlockType.COMMAND,
            text: Scratch.translate("disconnect"),
          },
        ],
      };
    }

    // --- Reporters/Booleans ---

    getRoom() {
      return this._room;
    }

    isConnected() {
      return !!this._connected;
    }

    getGesture() {
      return this._gesture || "";
    }

    getConfidence() {
      return round2(toFiniteNumber(this._confidence, 0));
    }

    getSubscribers() {
      return toFiniteNumber(this._subscribers, 0);
    }

    // --- Commands ---

    setRoom(args) {
      const room = normalizeRoom(args.ROOM);
      this.setRoomInternal(room, /*auto*/ false);
    }

    reconnect() {
      if (!this._room) {
        this._connected = false;
        return;
      }
      this._backoffIndex = 0;
      this._shouldReconnect = true;
      this._clearReconnectTimer();
      this._closeWs("manual reconnect");
      this._openWs();
    }

    disconnect() {
      this._shouldReconnect = false;
      this._clearReconnectTimer();
      this._stopRoomProbe();
      this._closeWs("manual disconnect");
      this._connected = false;
    }

    // --- Internal logic ---

    _startRoomProbe() {
      // Try for ~5 seconds to catch cases where URL params appear after extension executes.
      let tries = 0;
      const maxTries = 20; // 20 * 250ms = 5s
      const intervalMs = 250;

      if (this._roomProbeTimer) return;

      this._roomProbeTimer = setInterval(() => {
        tries += 1;

        if (this._room) {
          this._stopRoomProbe();
          return;
        }

        const roomFromEditor = normalizeRoom(getRoomFromWindow());
        const roomFromScript = normalizeRoom(getParamFromCurrentScript("room"));
        const found = roomFromEditor || roomFromScript;

        if (found) {
          this._stopRoomProbe();
          this.setRoomInternal(found, /*auto*/ true);
          return;
        }

        if (tries >= maxTries) {
          this._stopRoomProbe();
        }
      }, intervalMs);
    }

    _stopRoomProbe() {
      if (this._roomProbeTimer) {
        try {
          clearInterval(this._roomProbeTimer);
        } catch (e) {
          // ignore
        }
        this._roomProbeTimer = null;
      }
    }

    setRoomInternal(room, auto) {
      if (!room) {
        this._room = "";
        this._connected = false;

        if (!auto) {
          this._shouldReconnect = false;
          this._clearReconnectTimer();
          this._closeWs("room cleared");
        }
        return;
      }

      // If unchanged, do nothing.
      if (room === this._room && this._ws) return;

      this._room = room;

      // Reset values when room changes.
      this._gesture = "";
      this._confidence = 0;
      this._subscribers = 0;

      // (Re)connect
      this._backoffIndex = 0;
      this._shouldReconnect = true;
      this._clearReconnectTimer();
      this._closeWs("room changed");
      this._openWs();
    }

    _buildWsUrl() {
      const base = this._wsBase || DEFAULT_WS_BASE;
      const u = new URL(base);
      u.searchParams.set("room", this._room);
      return u.toString();
    }

    _openWs() {
      void this._openWsAsync();
    }

    async _openWsAsync() {
      if (!this._room) {
        this._connected = false;
        return;
      }
      if (!this._shouldReconnect) {
        this._connected = false;
        return;
      }

      let wsUrl = "";
      try {
        wsUrl = this._buildWsUrl();
      } catch (e) {
        this._wsBase = DEFAULT_WS_BASE;
        try {
          wsUrl = this._buildWsUrl();
        } catch (e2) {
          this._connected = false;
          this._scheduleReconnect();
          return;
        }
      }

      // Permission check (use http/https equivalent for ws/wss)
      const canFetchUrl = toCanFetchUrl(wsUrl);
      if (!canFetchUrl) {
        this._connected = false;
        this._scheduleReconnect();
        return;
      }

      let allowed = false;
      try {
        allowed = await Scratch.canFetch(canFetchUrl);
      } catch (e) {
        this._connected = false;
        this._scheduleReconnect();
        return;
      }

      if (!allowed) {
        this._connected = false;
        this._scheduleReconnect();
        return;
      }

      try {
        const ws = new WebSocket(wsUrl);
        this._ws = ws;

        ws.onopen = () => {
          this._connected = true;
          this._backoffIndex = 0;
        };

        ws.onmessage = (evt) => {
          const msg = safeJsonParse(evt.data);
          if (!msg || typeof msg !== "object") return;

          if (msg.type === "gesture") {
            const label = typeof msg.label === "string" ? msg.label : "";
            const conf = toFiniteNumber(msg.confidence, 0);
            this._gesture = label;
            this._confidence = conf;
          } else if (msg.type === "presence") {
            const subs = toFiniteNumber(msg.subscribers, this._subscribers);
            this._subscribers = subs;
          }
        };

        ws.onerror = () => {
          this._connected = false;
        };

        ws.onclose = () => {
          this._connected = false;
          this._ws = null;
          this._scheduleReconnect();
        };
      } catch (e) {
        this._connected = false;
        this._ws = null;
        this._scheduleReconnect();
      }
    }

    _closeWs(reason) {
      const ws = this._ws;
      this._ws = null;

      if (ws) {
        try {
          ws.onopen = null;
          ws.onmessage = null;
          ws.onerror = null;
          ws.onclose = null;
          ws.close(1000, reason || "close");
        } catch (e) {
          // ignore
        }
      }
    }

    _scheduleReconnect() {
      if (!this._shouldReconnect) return;
      if (!this._room) return;

      if (this._reconnectTimer) return;

      const idx = Math.min(this._backoffIndex, BACKOFF_MS.length - 1);
      const delay = BACKOFF_MS[idx];

      this._backoffIndex = Math.min(
        this._backoffIndex + 1,
        BACKOFF_MS.length - 1
      );

      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        if (this._ws) return;
        if (!this._shouldReconnect) return;
        if (!this._room) return;
        this._openWs();
      }, delay);
    }

    _clearReconnectTimer() {
      if (this._reconnectTimer) {
        try {
          clearTimeout(this._reconnectTimer);
        } catch (e) {
          // ignore
        }
        this._reconnectTimer = null;
      }
    }
  }

  Scratch.extensions.register(new SmartteamLiveExtension());
})(Scratch);
