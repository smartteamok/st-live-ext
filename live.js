// Name: SmartTEAM Live
// ID: smartteamlive
// Description: Read real-time AI signals from a SmartTEAM WebSocket room (currently gestures).
// By: marianobat <https://scratch.mit.edu/users/marianobat/>
// License: MPL-2.0
// Manual testing (sandboxed):
// https://turbowarp.org/editor?extension=https%3A%2F%2Flocalhost%3A8000%2Fmarianobat%2Flive.js%3Froom%3DST-XXXX%26wsBase%3Dwss%3A%2F%2Fsmartteam-gesture-bridge.marianobat.workers.dev%2Fws
//
// Notes:
// - In sandboxed mode, the extension cannot reliably read the editor URL (?room=...).
// - To provide a default room value, pass room via the extension script URL:
//   live.js?room=ST-... (URL-encoded inside the editor's extension= parameter)

(function (Scratch) {
  "use strict";

  if (!Scratch) return;

  // Provide in-extension translations for immediate UX.
  // TurboWarp commonly uses es-419 for Latin American Spanish.
  const translations = {
    en: {
      "SmartTEAM Live": "SmartTEAM Live",
      room: "room",
      "connected?": "connected?",
      class: "class",
      confidence: "confidence",
      subscribers: "subscribers",
      "set room to [ROOM]": "set room to [ROOM]",
      reconnect: "reconnect",
      disconnect: "disconnect",
    },
    es: {
      "SmartTEAM Live": "SmartTEAM Live",
      room: "sala",
      "connected?": "¿conectado?",
      class: "clase",
      confidence: "confianza",
      subscribers: "suscriptores",
      "set room to [ROOM]": "establecer sala a [ROOM]",
      reconnect: "reconectar",
      disconnect: "desconectar",
    },
    "es-419": {
      "SmartTEAM Live": "SmartTEAM Live",
      room: "sala",
      "connected?": "¿conectado?",
      class: "clase",
      confidence: "confianza",
      subscribers: "suscriptores",
      "set room to [ROOM]": "establecer sala a [ROOM]",
      reconnect: "reconectar",
      disconnect: "desconectar",
    },
    "es-ES": {
      "SmartTEAM Live": "SmartTEAM Live",
      room: "sala",
      "connected?": "¿conectado?",
      class: "clase",
      confidence: "confianza",
      subscribers: "suscriptores",
      "set room to [ROOM]": "establecer sala a [ROOM]",
      reconnect: "reconectar",
      disconnect: "desconectar",
    },
  };

  if (Scratch.translate && Scratch.translate.setup) {
    Scratch.translate.setup(translations);
  }

  function tr(str) {
    return Scratch.translate ? Scratch.translate(str) : str;
  }

  const DEFAULT_WS_BASE =
    "wss://smartteam-gesture-bridge.marianobat.workers.dev/ws";

  // Backoff sequence (ms). Cap is handled by last value.
  const BACKOFF_MS = [1000, 2000, 3000, 5000];

  /**
   * Read a param from the extension script URL (document.currentScript.src).
   * This is the most reliable way to receive parameters in sandboxed mode.
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

  class SmartteamLiveExtension {
    constructor() {
      // Internal state
      this._connected = false;
      this._room = "";
      this._wsBase = DEFAULT_WS_BASE;
      this._gesture = "";
      this._confidence = 0;
      this._subscribers = 0;

      // Default room shown in the "set room to" block.
      this._defaultRoom = "";

      // WebSocket + reconnect handling
      this._ws = null;
      this._shouldReconnect = false;
      this._reconnectTimer = null;
      this._backoffIndex = 0;

      // wsBase/room: from the extension script URL in sandboxed mode
      const wsBaseFromScript = getParamFromCurrentScript("wsBase");
      this._wsBase = normalizeWsBase(wsBaseFromScript);

      const roomFromScript = normalizeRoom(getParamFromCurrentScript("room"));
      this._defaultRoom = roomFromScript || "";

      // In sandboxed mode: only auto-connect if room is provided via script URL.
      if (roomFromScript) {
        this.setRoomInternal(roomFromScript, /*auto*/ true);
      } else {
        this._connected = false;
      }
    }

    getInfo() {
      return {
        id: "smartteamlive",
        name: tr("SmartTEAM Live"),
        blocks: [
          {
            opcode: "getRoom",
            blockType: Scratch.BlockType.REPORTER,
            text: tr("room"),
          },
          {
            opcode: "isConnected",
            blockType: Scratch.BlockType.BOOLEAN,
            text: tr("connected?"),
          },
          {
            opcode: "getGesture",
            blockType: Scratch.BlockType.REPORTER,
            text: tr("class"),
          },
          {
            opcode: "getConfidence",
            blockType: Scratch.BlockType.REPORTER,
            text: tr("confidence"),
          },
          {
            opcode: "getSubscribers",
            blockType: Scratch.BlockType.REPORTER,
            text: tr("subscribers"),
          },
          "---",
          {
            opcode: "setRoom",
            blockType: Scratch.BlockType.COMMAND,
            text: tr("set room to [ROOM]"),
            arguments: {
              ROOM: {
                type: Scratch.ArgumentType.STRING,
                // Default value shows the session room passed via script URL (if any).
                defaultValue: this._defaultRoom || "ST-XXXXXXX",
              },
            },
          },
          {
            opcode: "reconnect",
            blockType: Scratch.BlockType.COMMAND,
            text: tr("reconnect"),
          },
          {
            opcode: "disconnect",
            blockType: Scratch.BlockType.COMMAND,
            text: tr("disconnect"),
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
      this._closeWs("manual disconnect");
      this._connected = false;
    }

    // --- Internal logic ---

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

      // Keep default in sync for convenience.
      this._defaultRoom = room;

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

      // Permission check
      let allowed = false;
      try {
        allowed = await Scratch.canFetch(wsUrl);
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
        // eslint-disable-next-line extension/check-can-fetch
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
