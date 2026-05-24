(function () {
  if (window.YomiPhotonBridge) {
    return;
  }

  var EVENT_CODE = 1;
  var CONNECT_TIMEOUT_MS = 20000;
  /** Prevents flooding Godot when onJoinRoom and onActorJoin enumerate the same actors. */
  var lastEmitRegisterActorsDigest = "";
  var emittedRegisteredActorIds = {};
  var lastSyncIdsBySlot = { "1": 0, "2": 0 };

  function cloneList(items) {
    return items ? items.slice() : [];
  }

  /**
   * Photon / JSON bridging often deserialize Godot Array RPC args into plain objects
   * like { "0": a, "1": b }. Godot expects a real Array variant so callv() gets the right arity.
   *
   * Godot Dictionaries also use numeric keys (sync_ids uses {1: actorA, 2: actorB}).
   * Only zero-based {0,1,...} objects are pseudo-arrays; player-slot maps stay dicts.
   */
  function isMeaningfullyEmptyPhotonRelayCandidate(val) {
    if (val == null) {
      return true;
    }
    if (Array.isArray(val)) {
      return val.length === 0;
    }
    if (typeof val === "object") {
      return Object.keys(val).length === 0;
    }
    return false;
  }

  /**
   * Godot payloads use {"function_name", "arg"}. Some stacks also expose an "args" field —
   * prefer whichever side actually carries RPC data so an empty "args" cannot hide "arg".
   */
  function pickPhotonRelayPayload(content) {
    if (!content || typeof content !== "object") {
      return null;
    }
    var candArg = Object.prototype.hasOwnProperty.call(content, "arg") ? content.arg : null;
    var candArgs = Object.prototype.hasOwnProperty.call(content, "args") ? content.args : null;
    if (!isMeaningfullyEmptyPhotonRelayCandidate(candArg)) {
      return candArg;
    }
    if (!isMeaningfullyEmptyPhotonRelayCandidate(candArgs)) {
      return candArgs;
    }
    if (candArg != null) {
      return candArg;
    }
    return candArgs;
  }

  function isZeroBasedNumericObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    var keys = Object.keys(value);
    if (!keys.length) {
      return false;
    }
    if (!keys.every(function (k) {
      return /^(?:0|[1-9]\d*)$/.test(k);
    })) {
      return false;
    }
    keys.sort(function (a, b) {
      return Number(a) - Number(b);
    });
    return keys.every(function (k, idx) {
      return Number(k) === idx;
    });
  }

  function normalizePhotonRelayArg(value) {
    if (value == null || typeof value !== "object") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(normalizePhotonRelayArg);
    }
    var keys = Object.keys(value);
    if (!keys.length) {
      return value;
    }
    if (isZeroBasedNumericObject(value)) {
      keys.sort(function (a, b) {
        return Number(a) - Number(b);
      });
      return keys.map(function (k) {
        return normalizePhotonRelayArg(value[k]);
      });
    }
    var out = {};
    for (var i = 0; i < keys.length; i += 1) {
      var kk = keys[i];
      out[kk] = normalizePhotonRelayArg(value[kk]);
    }
    return out;
  }

  /** Network.gd callv() needs [a,b], not [[a,b]] — a nested array counts as one argument. */
  function flattenRelayArg(value) {
    var cur = normalizePhotonRelayArg(value);
    while (Array.isArray(cur) && cur.length === 1 && Array.isArray(cur[0])) {
      cur = normalizePhotonRelayArg(cur[0]);
    }
    return cur;
  }

  /** Godot rpc_() passes Arrays to callv(); sync_ids passes a Dictionary to call(). */
  var RELAY_RPC_ARRAY_FUNCS = {
    sync_character_selection: true,
    register_player: true,
    send_action: true,
    send_chat_message: true,
    receive_player_timer: true,
    send_opponent_replay_for_resim: true
  };

  function objectToZeroBasedArray(value) {
    var keys = Object.keys(value).sort(function (a, b) {
      return Number(a) - Number(b);
    });
    return keys.map(function (k) {
      return normalizePhotonRelayArg(value[k]);
    });
  }

  function ensureRelayArrayArg(arg) {
    if (Array.isArray(arg)) {
      return arg.map(normalizePhotonRelayArg);
    }
    if (isZeroBasedNumericObject(arg)) {
      return objectToZeroBasedArray(arg);
    }
    return arg;
  }

  function ensureRelayDictionaryArg(arg) {
    if (arg == null || typeof arg !== "object" || Array.isArray(arg)) {
      return arg;
    }
    if (isZeroBasedNumericObject(arg)) {
      return arg;
    }
    var out = {};
    var keys = Object.keys(arg);
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      out[key] = normalizePhotonRelayArg(arg[key]);
    }
    return out;
  }

  function toFiniteNumberOrNull(value) {
    var num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  function normalizePlayerSlotId(value, fallback) {
    var slot = toFiniteNumberOrNull(value);
    if (slot == null) {
      slot = toFiniteNumberOrNull(fallback);
    }
    if (slot == null) {
      return 0;
    }
    slot = Math.trunc(slot);
    return slot === 1 || slot === 2 ? slot : 0;
  }

  function resolvePlayerSlotFromSyncIds(value) {
    var candidate = toFiniteNumberOrNull(value);
    if (candidate == null) {
      return 0;
    }
    candidate = Math.trunc(candidate);
    if (candidate === 1 || candidate === 2) {
      return candidate;
    }
    if (Number(lastSyncIdsBySlot["1"]) === candidate) {
      return 1;
    }
    if (Number(lastSyncIdsBySlot["2"]) === candidate) {
      return 2;
    }
    return 0;
  }

  function resolvePlayerSlot(value, fallback) {
    var direct = normalizePlayerSlotId(value, fallback);
    if (direct !== 0) {
      return direct;
    }
    var byValue = resolvePlayerSlotFromSyncIds(value);
    if (byValue !== 0) {
      return byValue;
    }
    return resolvePlayerSlotFromSyncIds(fallback);
  }

  function extractCharacterName(value) {
    if (value == null) {
      return null;
    }
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (Array.isArray(value)) {
      for (var ai = 0; ai < value.length; ai += 1) {
        var arrayName = extractCharacterName(value[ai]);
        if (arrayName != null && arrayName !== "") {
          return arrayName;
        }
      }
      return null;
    }
    if (typeof value === "object") {
      if (Object.prototype.hasOwnProperty.call(value, "name")) {
        return extractCharacterName(value.name);
      }
      if (Object.prototype.hasOwnProperty.call(value, "character")) {
        return extractCharacterName(value.character);
      }
      if (Object.prototype.hasOwnProperty.call(value, "character_name")) {
        return extractCharacterName(value.character_name);
      }
      if (Object.prototype.hasOwnProperty.call(value, "char")) {
        return extractCharacterName(value.char);
      }
      var keys = Object.keys(value);
      for (var ki = 0; ki < keys.length; ki += 1) {
        var nestedName = extractCharacterName(value[keys[ki]]);
        if (nestedName != null && nestedName !== "") {
          return nestedName;
        }
      }
    }
    return null;
  }

  function normalizeCharacterSelectionPayload(rawCharacter) {
    if (rawCharacter == null) {
      return null;
    }
    if (Array.isArray(rawCharacter)) {
      if (!rawCharacter.length) {
        return null;
      }
      if (rawCharacter.length === 1) {
        return normalizeCharacterSelectionPayload(rawCharacter[0]);
      }
      for (var ai = 0; ai < rawCharacter.length; ai += 1) {
        var nestedCandidate = normalizeCharacterSelectionPayload(rawCharacter[ai]);
        if (nestedCandidate && nestedCandidate.name) {
          return nestedCandidate;
        }
      }
      return null;
    }
    if (typeof rawCharacter === "string") {
      return { name: rawCharacter };
    }
    if (typeof rawCharacter === "object") {
      var normalizedCharacter = normalizePhotonRelayArg(rawCharacter);
      if (Array.isArray(normalizedCharacter)) {
        return normalizeCharacterSelectionPayload(normalizedCharacter);
      }
      if (normalizedCharacter && typeof normalizedCharacter === "object") {
        var resolvedName = extractCharacterName(normalizedCharacter);
        if (resolvedName != null && resolvedName !== "") {
          normalizedCharacter.name = String(resolvedName);
          return normalizedCharacter;
        }
        // Preserve unknown object shapes instead of coercing to null.
        // Dropping this to null blocks match start (selected_characters[x] stays null).
        return normalizedCharacter;
      }
      return { name: String(rawCharacter) };
    }
    return { name: String(rawCharacter) };
  }

  function coerceSendMatchDataArg(rawArg) {
    var arg = flattenRelayArg(unwrapRelayEnvelope(rawArg));
    if (Array.isArray(arg) && arg.length === 1 && arg[0] != null && typeof arg[0] === "object") {
      arg = flattenRelayArg(arg[0]);
    }
    if (arg == null || typeof arg !== "object" || Array.isArray(arg)) {
      return arg;
    }
    var data = normalizePhotonRelayArg(arg);
    if (data == null || typeof data !== "object" || Array.isArray(data)) {
      return data;
    }

    var rawSelectedCharacters = data.selected_characters;
    if (rawSelectedCharacters != null && typeof rawSelectedCharacters === "object" && !Array.isArray(rawSelectedCharacters)) {
      var normalizedSelectedCharacters = {};
      var selectedCharacterKeys = Object.keys(rawSelectedCharacters);
      for (var i = 0; i < selectedCharacterKeys.length; i += 1) {
        var key = selectedCharacterKeys[i];
        var slot = normalizePlayerSlotId(key, key);
        if (slot !== 1 && slot !== 2) {
          continue;
        }
        var normalizedCharacter = normalizeCharacterSelectionPayload(rawSelectedCharacters[key]);
        normalizedSelectedCharacters[String(slot)] = normalizedCharacter;
      }
      data.selected_characters = normalizedSelectedCharacters;
    }

    var rawSelectedStyles = data.selected_styles;
    if (rawSelectedStyles != null && typeof rawSelectedStyles === "object" && !Array.isArray(rawSelectedStyles)) {
      var normalizedSelectedStyles = {};
      var selectedStyleKeys = Object.keys(rawSelectedStyles);
      for (var si = 0; si < selectedStyleKeys.length; si += 1) {
        var styleKey = selectedStyleKeys[si];
        var styleSlot = normalizePlayerSlotId(styleKey, styleKey);
        if (styleSlot !== 1 && styleSlot !== 2) {
          continue;
        }
        normalizedSelectedStyles[String(styleSlot)] = normalizePhotonRelayArg(rawSelectedStyles[styleKey]);
      }
      data.selected_styles = normalizedSelectedStyles;
    }

    return data;
  }

  function coerceSyncIdsArg(rawArg) {
    var arg = ensureRelayDictionaryArg(ensureRelayArrayArg(flattenRelayArg(unwrapRelayEnvelope(rawArg))));
    var slotOne = null;
    var slotTwo = null;

    // Some bridge paths wrap sync_ids as [ { "1": idA, "2": idB } ].
    // Unwrap this shape before slot extraction so IDs stay aligned with get_local_id().
    if (Array.isArray(arg) && arg.length === 1 && arg[0] != null && typeof arg[0] === "object") {
      arg = ensureRelayDictionaryArg(ensureRelayArrayArg(flattenRelayArg(arg[0])));
    }

    if (Array.isArray(arg)) {
      if (arg.length >= 2) {
        slotOne = toFiniteNumberOrNull(arg[0]);
        slotTwo = toFiniteNumberOrNull(arg[1]);
      }
    } else if (arg && typeof arg === "object") {
      slotOne = toFiniteNumberOrNull(
        Object.prototype.hasOwnProperty.call(arg, "1") ? arg["1"] :
        Object.prototype.hasOwnProperty.call(arg, 1) ? arg[1] :
        Object.prototype.hasOwnProperty.call(arg, "0") ? arg["0"] :
        Object.prototype.hasOwnProperty.call(arg, 0) ? arg[0] :
        null
      );
      slotTwo = toFiniteNumberOrNull(
        Object.prototype.hasOwnProperty.call(arg, "2") ? arg["2"] :
        Object.prototype.hasOwnProperty.call(arg, 2) ? arg[2] :
        Object.prototype.hasOwnProperty.call(arg, "1") ? arg["1"] :
        Object.prototype.hasOwnProperty.call(arg, 1) ? arg[1] :
        null
      );
    }

    var normalizedIds = {
      "1": slotOne == null ? 0 : slotOne,
      "2": slotTwo == null ? 0 : slotTwo
    };
    lastSyncIdsBySlot = {
      "1": normalizedIds["1"],
      "2": normalizedIds["2"]
    };
    return normalizedIds;
  }

  function coerceSyncCharacterSelectionArg(rawArg, clientId) {
    var arg = ensureRelayArrayArg(flattenRelayArg(unwrapRelayEnvelope(rawArg)));
    var playerId = null;
    var character = null;
    var style = null;

    if (Array.isArray(arg)) {
      playerId = resolvePlayerSlot(arg[0], clientId);
      if (arg.length >= 2) {
        character = normalizeCharacterSelectionPayload(arg[1]);
      }
      if (arg.length >= 3) {
        style = arg[2] == null ? null : normalizePhotonRelayArg(arg[2]);
      }
    } else if (arg && typeof arg === "object") {
      playerId = resolvePlayerSlot(
        arg.player_id != null ? arg.player_id :
        arg.player != null ? arg.player :
        arg.sender_actor != null ? arg.sender_actor :
        arg.actor_nr != null ? arg.actor_nr :
        arg.actorNr != null ? arg.actorNr :
        arg.id,
        clientId
      );
      var resolvedCharacter = (
        arg.character != null ? arg.character :
        arg.character_name != null ? arg.character_name :
        arg.character_id != null ? arg.character_id :
        arg.char != null ? arg.char :
        arg.name != null ? arg.name :
        arg.index
      );
      character = normalizeCharacterSelectionPayload(resolvedCharacter);
      if (Object.prototype.hasOwnProperty.call(arg, "style")) {
        style = arg.style == null ? null : normalizePhotonRelayArg(arg.style);
      }
    } else if (arg != null) {
      playerId = resolvePlayerSlot(clientId, null);
      character = normalizeCharacterSelectionPayload(arg);
    }

    return [
      resolvePlayerSlot(playerId, clientId),
      character,
      style
    ];
  }

  function unwrapRelayEnvelope(arg) {
    var cur = arg;
    while (cur != null && typeof cur === "object" && !Array.isArray(cur)) {
      if (Object.prototype.hasOwnProperty.call(cur, "arg")) {
        cur = cur.arg;
      } else if (Object.prototype.hasOwnProperty.call(cur, "args")) {
        cur = cur.args;
      } else {
        break;
      }
    }
    return cur;
  }

  function coerceRelayRpcForGodot(functionName, rawArg, clientId) {
    if (functionName === "sync_ids") {
      return coerceSyncIdsArg(rawArg);
    }

    if (functionName === "sync_character_selection") {
      return coerceSyncCharacterSelectionArg(rawArg, clientId);
    }

    if (functionName === "send_match_data") {
      return coerceSendMatchDataArg(rawArg);
    }

    var arg = flattenRelayArg(unwrapRelayEnvelope(rawArg));
    if (RELAY_RPC_ARRAY_FUNCS[functionName]) {
      return ensureRelayArrayArg(arg);
    }

    return arg;
  }

  window.YomiPhotonBridge = {
    client: null,
    callback: null,
    connectedOnce: false,
    createRetryCount: 0,
    pendingRoomCode: "",
    pendingPublicMatch: true,
    pendingVersion: null,
    pendingPlayerName: "",
    pendingAppId: "",
    pendingAppVersion: "",
    pendingRegion: "US",
    connectAttemptIndex: 0,
    connectTimeoutId: null,
    nameServerAddresses: ["wss://ns.photonengine.io:19093", "wss://ns.photonengine.io:443"],

    _clearConnectTimeout: function () {
      if (this.connectTimeoutId) {
        clearTimeout(this.connectTimeoutId);
        this.connectTimeoutId = null;
      }
    },

    _startConnectTimeout: function () {
      var self = this;
      this._clearConnectTimeout();
      this.connectTimeoutId = setTimeout(function () {
        if (self.connectedOnce) {
          return;
        }
        self._emitConnectionFailed(
          "Timed out connecting to Photon. Check your network, ad blocker, or set a custom App ID in photon-config.js."
        );
      }, CONNECT_TIMEOUT_MS);
    },

    _emit: function (payload) {
      if (this.callback) {
        this.callback(JSON.stringify(payload));
      }
    },

    _myActorId: function () {
      if (!this.client || !this.client.myActor()) {
        return 0;
      }
      return this.client.myActor().actorNr || 0;
    },

    _emitConnectionEnded: function () {
      this._clearConnectTimeout();
      this._emit({
        type: "connection_ended",
        client_id: this._myActorId()
      });
    },

    _emitConnectionFailed: function (message) {
      this._clearConnectTimeout();
      this._emit({
        type: "connection_failed",
        message: message || "Photon connection failed.",
        client_id: this._myActorId()
      });
    },

    _roomListPayload: function () {
      if (!this.client || !this.client.availableRooms) {
        return [];
      }

      return this.client
        .availableRooms()
        .filter(function (room) {
          return room && !room.removed && room.isVisible && room.playerCount < 2;
        })
        .map(function (room) {
          return {
            host: room.getCustomPropertyOrElse("host", "Host"),
            code: room.name
          };
        });
    },

    _emitRoomList: function () {
      this._emit({
        type: "match_list",
        list: this._roomListPayload(),
        client_id: this._myActorId()
      });
    },

    _emitPlayerCount: function () {
      var rooms = this._roomListPayload();
      var total = 0;
      for (var i = 0; i < rooms.length; i += 1) {
        total += 1;
      }
      if (this.client && this.client.isJoinedToRoom && this.client.isJoinedToRoom()) {
        total = Math.max(total, this.client.myRoomActorCount());
      }
      this._emit({
        type: "player_count",
        count: total,
        client_id: this._myActorId()
      });
    },

    _emitRegisterSync: function () {
      if (!this.client || !this.client.isJoinedToRoom || !this.client.isJoinedToRoom()) {
        return;
      }

      var actors = cloneList(this.client.myRoomActorsArray());
      actors.sort(function (a, b) {
        return a.actorNr - b.actorNr;
      });

      var digest = actors
        .map(function (a) {
          return String(a.actorNr || 0);
        })
        .join("|");
      if (digest === lastEmitRegisterActorsDigest) {
        return;
      }
      lastEmitRegisterActorsDigest = digest;

      for (var i = 0; i < actors.length; i += 1) {
        var actor = actors[i];
        var actorId = Number(actor.actorNr) || 0;
        if (actorId <= 0 || emittedRegisteredActorIds[actorId]) {
          continue;
        }
        emittedRegisteredActorIds[actorId] = true;
        this._emit({
          type: "player_registered",
          name: actor.name || ("Player " + actorId),
          id: actorId,
          version: actor.getCustomPropertyOrElse("version", null),
          client_id: this._myActorId()
        });
      }
    },

    _createRoomWithRetry: function () {
      if (!this.client) {
        return;
      }

      this.pendingRoomCode = this._randomRoomCode();
      this.client.createRoom(this.pendingRoomCode, {
        isVisible: this.pendingPublicMatch,
        isOpen: true,
        maxPlayers: 2,
        customGameProperties: {
          host: this.pendingPlayerName,
          version: this.pendingVersion,
          public: this.pendingPublicMatch
        },
        propsListedInLobby: ["host", "version", "public"]
      });
    },

    _randomRoomCode: function () {
      var alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      var code = "";
      for (var i = 0; i < 6; i += 1) {
        code += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
      return code;
    },

    _currentNameServerAddress: function () {
      return this.nameServerAddresses[Math.min(this.connectAttemptIndex, this.nameServerAddresses.length - 1)];
    },

    _retryConnection: function () {
      if (this.connectedOnce || this.connectAttemptIndex + 1 >= this.nameServerAddresses.length) {
        return false;
      }
      this.connectAttemptIndex += 1;
      try {
        if (this.client) {
          this.client.disconnect();
        }
      } catch (_error) {
      }
      this.client = null;
      this._connectClient();
      return true;
    },

    _connectClient: function () {
      if (typeof Photon === "undefined") {
        this._emitConnectionFailed("Photon SDK not loaded.");
        return;
      }

      var LBC = Photon.LoadBalancing.LoadBalancingClient;
      var self = this;
      var client = new LBC(Photon.ConnectionProtocol.Wss, this.pendingAppId, this.pendingAppVersion);
      client.autoJoinLobby = true;
      if (window.YOMIH_PHOTON_DEBUG && client.setLogLevel && typeof Photon.LogLevel !== "undefined") {
        try {
          client.setLogLevel(Photon.LogLevel.DEBUG);
        } catch (_logErr) {}
      }
      if (client.setNameServerAddress) {
        client.setNameServerAddress(this._currentNameServerAddress());
      }

      client.onStateChange = function (state) {
        if (self.client !== client) {
          return;
        }
        var stateName = LBC.StateToName(state);
        if (stateName === "JoinedLobby") {
          self.connectedOnce = true;
          self.connectAttemptIndex = 0;
          self._clearConnectTimeout();
          self._emit({
            type: "connection_succeeded",
            client_id: self._myActorId()
          });
          self._emitRoomList();
          self._emitPlayerCount();
        } else if (stateName === "Disconnected" || stateName === "Error") {
          if (!self.connectedOnce && self._retryConnection()) {
            return;
          }
          if (self.connectedOnce) {
            self._emitConnectionEnded();
          } else {
            self._emitConnectionFailed("Photon disconnected before joining the lobby.");
          }
        }
      };

      client.onRoomList = function () {
        if (self.client !== client) {
          return;
        }
        self._emitRoomList();
        self._emitPlayerCount();
      };

      client.onRoomListUpdate = function () {
        if (self.client !== client) {
          return;
        }
        self._emitRoomList();
        self._emitPlayerCount();
      };

      client.onJoinRoom = function (createdByMe) {
        if (self.client !== client) {
          return;
        }
        self._clearConnectTimeout();
        if (createdByMe) {
          self.createRetryCount = 0;
          self._emit({
            type: "match_created",
            code: client.myRoom().name,
            client_id: self._myActorId()
          });
        } else {
          self._emit({
            type: "room_join_confirm",
            client_id: self._myActorId()
          });
        }
        self._emitRegisterSync();
      };

      client.onActorJoin = function () {
        if (self.client !== client) {
          return;
        }
        self._emitRegisterSync();
        self._emitPlayerCount();
      };

      client.onActorLeave = function (actor) {
        if (self.client !== client) {
          return;
        }
        lastEmitRegisterActorsDigest = "";
        var departedActorId = Number(actor.actorNr) || 0;
        if (departedActorId > 0 && Object.prototype.hasOwnProperty.call(emittedRegisteredActorIds, departedActorId)) {
          delete emittedRegisteredActorIds[departedActorId];
        }
        self._emit({
          type: "peer_disconnected",
          id: actor.actorNr,
          client_id: self._myActorId()
        });
        self._emitPlayerCount();
      };

      client.onEvent = function (code, content, actorNr) {
        if (self.client !== client || code !== EVENT_CODE) {
          return;
        }
        var senderActor = Number(actorNr) || 0;
        if (senderActor !== 0 && senderActor === self._myActorId()) {
          return;
        }
        var rawRelay = pickPhotonRelayPayload(content);
        var normalized = coerceRelayRpcForGodot(
          content.function_name,
          rawRelay,
          senderActor || self._myActorId()
        );
        if (window.YOMIH_PHOTON_DEBUG) {
          try {
            console.log("[yomih-photon] relay_rpc recv", {
              function_name: content.function_name,
              sender_actor: senderActor,
              raw: rawRelay,
              normalized: normalized
            });
            if (content.function_name === "sync_character_selection") {
              console.log("[yomih-photon] recv sync_character_selection parsed", {
                sender_actor: senderActor,
                player_id: Array.isArray(normalized) ? normalized[0] : null,
                character: Array.isArray(normalized) ? normalized[1] : null,
                style: Array.isArray(normalized) ? normalized[2] : null
              });
            } else if (content.function_name === "send_match_data") {
              var recvChars = normalized && normalized.selected_characters ? normalized.selected_characters : null;
              console.log("[yomih-photon] recv send_match_data parsed", {
                has_selected_characters: !!recvChars,
                p1: recvChars ? recvChars["1"] : null,
                p2: recvChars ? recvChars["2"] : null
              });
            }
          } catch (_logErr) {}
        }
        self._emit({
          type: "relay_rpc",
          function_name: content.function_name,
          arg: normalized,
          client_id: self._myActorId()
        });
      };

      client.onOperationResponse = function (errorCode, errorMsg, code) {
        if (self.client !== client || !errorCode) {
          return;
        }

        var op = Photon.LoadBalancing.Constants.OperationCode;
        if (code === op.CreateGame && self.createRetryCount < 5) {
          self.createRetryCount += 1;
          self._createRoomWithRetry();
          return;
        }

        if (code === op.JoinGame) {
          self._emit({
            type: "room_join_deny",
            message: errorMsg || "Unable to join room.",
            client_id: self._myActorId()
          });
        }

        self._emit({
          type: "game_error",
          message: errorMsg || "Photon operation failed.",
          client_id: self._myActorId()
        });
      };

      client.onError = function (errorCode, errorMsg) {
        if (self.client !== client) {
          return;
        }
        if (!self.connectedOnce && self._retryConnection()) {
          return;
        }
        if (self.connectedOnce) {
          self._emit({
            type: "game_error",
            message: errorMsg || ("Photon error " + errorCode),
            client_id: self._myActorId()
          });
        } else {
          self._emitConnectionFailed(errorMsg || ("Photon error " + errorCode));
        }
      };

      this.client = client;
      client.connectToRegionMaster(this.pendingRegion || "US");
    },

    connect: function (appId, appVersion, region, callback) {
      this.disconnect();
      this.callback = callback;
      this.connectedOnce = false;
      this.createRetryCount = 0;
      this.connectAttemptIndex = 0;
      this.pendingRoomCode = "";
      this.pendingPlayerName = "";
      this.pendingVersion = null;
      emittedRegisteredActorIds = {};
      lastSyncIdsBySlot = { "1": 0, "2": 0 };

      var config = window.YOMIH_PHOTON_CONFIG || {};
      this.pendingAppId = config.appId || appId;
      this.pendingAppVersion = config.appVersion || appVersion || "1.0";
      this.pendingRegion = String(config.region || region || "US").toUpperCase();

      try {
        this._startConnectTimeout();
        this._connectClient();
      } catch (error) {
        this._emitConnectionFailed(String(error));
      }
    },

    disconnect: function () {
      this._clearConnectTimeout();
      if (this.client) {
        try {
          this.client.disconnect();
        } catch (_error) {
        }
      }
      this.client = null;
      this.connectedOnce = false;
      lastEmitRegisterActorsDigest = "";
      emittedRegisteredActorIds = {};
      lastSyncIdsBySlot = { "1": 0, "2": 0 };
    },

    createMatch: function (playerName, publicMatch, version) {
      if (!this.client) {
        return;
      }
      try {
        if (typeof playerName === "string" && playerName && typeof localStorage !== "undefined") {
          localStorage.setItem("yomih_last_multiplayer_player_name", playerName);
        }
      } catch (_e) {}
      this.pendingPlayerName = playerName;
      this.pendingPublicMatch = !!publicMatch;
      this.pendingVersion = version;
      this.createRetryCount = 0;
      this.client.myActor().setName(playerName);
      this.client.myActor().setCustomProperty("version", version);
      this._createRoomWithRetry();
    },

    joinMatch: function (playerName, roomCode, version) {
      if (!this.client) {
        return;
      }
      try {
        if (typeof playerName === "string" && playerName && typeof localStorage !== "undefined") {
          localStorage.setItem("yomih_last_multiplayer_player_name", playerName);
        }
      } catch (_e) {}
      this.pendingPlayerName = playerName;
      this.pendingVersion = version;
      this.client.myActor().setName(playerName);
      this.client.myActor().setCustomProperty("version", version);
      this.client.joinRoom(String(roomCode || "").trim().toUpperCase());
    },

    requestMatchList: function () {
      this._emitRoomList();
    },

    requestPlayerCount: function () {
      this._emitPlayerCount();
    },

    sendRelayRpc: function (functionName, arg) {
      if (!this.client || !this.client.isJoinedToRoom || !this.client.isJoinedToRoom()) {
        return;
      }
      var normalized = coerceRelayRpcForGodot(
        functionName,
        arg,
        this._myActorId()
      );
      if (window.YOMIH_PHOTON_DEBUG) {
        try {
          console.log("[yomih-photon] relay_rpc send", {
            function_name: functionName,
            arg: arg,
            normalized: normalized
          });
          if (functionName === "sync_character_selection") {
            console.log("[yomih-photon] send sync_character_selection parsed", {
              player_id: Array.isArray(normalized) ? normalized[0] : null,
              character: Array.isArray(normalized) ? normalized[1] : null,
              style: Array.isArray(normalized) ? normalized[2] : null
            });
          } else if (functionName === "send_match_data") {
            var sendChars = normalized && normalized.selected_characters ? normalized.selected_characters : null;
            console.log("[yomih-photon] send send_match_data parsed", {
              has_selected_characters: !!sendChars,
              p1: sendChars ? sendChars["1"] : null,
              p2: sendChars ? sendChars["2"] : null
            });
          }
        } catch (_logErr) {}
      }
      this.client.raiseEvent(EVENT_CODE, {
        function_name: functionName,
        arg: normalized
      }, {
        receivers: Photon.LoadBalancing.Constants.ReceiverGroup.Others
      });
    },

    service: function () {
    }
  };
})();
