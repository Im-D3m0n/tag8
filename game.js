/* ==========================================================
   TAGGED — a side-view platformer tag game
   - Local 2-player (same keyboard): P1 = WASD, P2 = Arrow keys
   - Online multiplayer across devices via WebRTC (PeerJS)
     Host is authoritative: simulates physics, broadcasts state.
     Clients send input, render whatever the host sends back.
   - Large obstacle-course arena
   ========================================================== */

const COLORS = ["#5de4c7", "#ffd166", "#c792ea", "#82aaff", "#ff8fa3", "#a3f7bf"];

const PLAYER_W = 32;
const PLAYER_H = 46;

const TAG_DISTANCE = 34;
const TAG_COOLDOWN_MS = 1500;
const GAME_DURATION_MS = 2 * 60 * 1000;

const MOVE_SPEED = 260;
const GRAVITY = 1500;
const JUMP_VELOCITY = -620;
const MAX_FALL_SPEED = 900;

const NETWORK_TICK_MS = 50;

const $ = (id) => document.getElementById(id);

const screens = {
  menu: $("screen-menu"),
  host: $("screen-host"),
  join: $("screen-join"),
  game: $("screen-game"),
  gameover: $("screen-gameover"),
};

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add("hidden"));
  screens[name].classList.remove("hidden");
}

document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", () => {
    teardownNetwork();
    showScreen("menu");
  });
});

/* ----------------------- shared game state ----------------------- */

let mode = null;
let peer = null;
let hostConn = null;
let clientConns = new Map();

let players = {};
let platforms = [];

let localPlayerId = null;
let roomCode = null;

let gameRunning = false;
let gameEndsAt = 0;
let lastTagAt = 0;

const keys = {};

const jumpQueue = {
  p1: false,
  p2: false,
  solo: false
};

const canvas = $("game-canvas");
const ctx = canvas.getContext("2d");

function resizeCanvas() {
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;

  canvas.style.width = window.innerWidth + "px";
  canvas.style.height = window.innerHeight + "px";

  ctx.setTransform(
    devicePixelRatio,
    0,
    0,
    devicePixelRatio,
    0,
    0
  );
}

window.addEventListener("resize", resizeCanvas);

function arenaSize() {
  return {
    w: window.innerWidth,
    h: window.innerHeight
  };
}


/* ----------------------- obstacle / platform generation ----------------------- */

function generatePlatforms(size) {
  const list = [];

  // Ground
  list.push({
    x: 0,
    y: size.h - 36,
    w: size.w,
    h: 36
  });

  // Large obstacle course
  const patterns = [
    [0.05, 0.78, 0.18],
    [0.28, 0.70, 0.15],
    [0.48, 0.82, 0.16],
    [0.70, 0.72, 0.18],
    [0.84, 0.58, 0.12],

    [0.10, 0.58, 0.14],
    [0.30, 0.50, 0.16],
    [0.52, 0.60, 0.14],
    [0.67, 0.48, 0.15],
    [0.82, 0.40, 0.13],

    [0.04, 0.38, 0.13],
    [0.22, 0.32, 0.14],
    [0.42, 0.40, 0.15],
    [0.60, 0.30, 0.14],
    [0.76, 0.24, 0.16],

    [0.12, 0.20, 0.15],
    [0.34, 0.18, 0.13],
    [0.52, 0.22, 0.13],
    [0.68, 0.14, 0.14],
    [0.84, 0.18, 0.12],

    [0.24, 0.76, 0.10],
    [0.57, 0.72, 0.10],
    [0.76, 0.64, 0.09]
  ];

  patterns.forEach(([xp, yp, wp], i) => {
    const w = Math.max(75, size.w * wp);

    const x = Math.max(
      8,
      Math.min(
        size.w - w - 8,
        size.w * xp
      )
    );

    const y = Math.max(
      70,
      Math.min(
        size.h - 65,
        size.h * yp
      )
    );

    list.push({
      x,
      y,
      w,
      h: i % 5 === 0 ? 28 : 20
    });
  });

  // Central battle platform
  list.push({
    x: size.w / 2 - Math.min(120, size.w * 0.12),
    y: size.h * 0.34,
    w: Math.min(240, size.w * 0.24),
    h: 22
  });

  // Lower central platform
  list.push({
    x: size.w / 2 - Math.min(90, size.w * 0.09),
    y: size.h * 0.55,
    w: Math.min(180, size.w * 0.18),
    h: 22
  });

  return list;
}


/* ----------------------- input handling ----------------------- */

window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();

  if (!keys[k]) {
    if (k === "w") jumpQueue.p1 = true;
    if (k === "arrowup") jumpQueue.p2 = true;

    if (k === "w" || k === "arrowup") {
      jumpQueue.solo = true;
    }
  }

  keys[k] = true;

  if (
    [
      "arrowup",
      "arrowdown",
      "arrowleft",
      "arrowright",
      " "
    ].includes(k)
  ) {
    e.preventDefault();
  }
});

window.addEventListener("keyup", (e) => {
  keys[e.key.toLowerCase()] = false;
});


/* ----------------------- touch controls ----------------------- */

const touchState = {
  left: false,
  right: false,
  jump: false
};

function readWASDInput() {
  let x = 0;

  if (keys["a"]) x -= 1;
  if (keys["d"]) x += 1;

  if (touchState.left) x -= 1;
  if (touchState.right) x += 1;

  const jump =
    jumpQueue.p1 ||
    (touchState.jump && !touchState._p1Consumed);

  jumpQueue.p1 = false;

  return {
    x: Math.max(-1, Math.min(1, x)),
    jump
  };
}

function readArrowInput() {
  let x = 0;

  if (keys["arrowleft"]) x -= 1;
  if (keys["arrowright"]) x += 1;

  const jump = jumpQueue.p2;

  jumpQueue.p2 = false;

  return {
    x: Math.max(-1, Math.min(1, x)),
    jump
  };
}

function readSoloInput() {
  let x = 0;

  if (keys["a"] || keys["arrowleft"]) x -= 1;
  if (keys["d"] || keys["arrowright"]) x += 1;

  if (touchState.left) x -= 1;
  if (touchState.right) x += 1;

  const jump =
    jumpQueue.solo ||
    touchState.jump;

  jumpQueue.solo = false;
  touchState.jump = false;

  return {
    x: Math.max(-1, Math.min(1, x)),
    jump
  };
}


/* ----------------------- touch buttons ----------------------- */

(function setupTouchButtons() {
  const zone = $("touch-controls");

  zone.innerHTML = `
    <div id="btn-touch-left" class="touch-btn touch-btn-left">◀</div>
    <div id="btn-touch-right" class="touch-btn touch-btn-right">▶</div>
    <div id="btn-touch-jump" class="touch-btn touch-btn-jump">⤴</div>
  `;

  const left = $("btn-touch-left");
  const right = $("btn-touch-right");
  const jump = $("btn-touch-jump");

  function bind(el, key) {
    const start = (e) => {
      e.preventDefault();
      touchState[key] = true;
    };

    const end = (e) => {
      e.preventDefault();
      touchState[key] = false;
    };

    el.addEventListener("touchstart", start, {
      passive: false
    });

    el.addEventListener("touchend", end, {
      passive: false
    });

    el.addEventListener("touchcancel", end, {
      passive: false
    });
  }

  bind(left, "left");
  bind(right, "right");

  jump.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();

      touchState.jump = true;

      jumpQueue.p1 = true;
      jumpQueue.p2 = true;
      jumpQueue.solo = true;
    },
    {
      passive: false
    }
  );
})();

function isTouchDevice() {
  return (
    "ontouchstart" in window ||
    navigator.maxTouchPoints > 0
  );
}


/* ----------------------- menu wiring ----------------------- */

$("btn-host").addEventListener(
  "click",
  startHostFlow
);

$("btn-join").addEventListener(
  "click",
  () => showScreen("join")
);

$("btn-local").addEventListener(
  "click",
  startLocalGame
);

$("btn-connect").addEventListener(
  "click",
  connectToHost
);

$("btn-copy-code").addEventListener(
  "click",
  () => {
    navigator.clipboard?.writeText(roomCode || "");

    $("btn-copy-code").textContent =
      "Copied!";

    setTimeout(
      () =>
        ($("btn-copy-code").textContent =
          "Copy Code"),
      1200
    );
  }
);

$("btn-play-again").addEventListener(
  "click",
  () => {
    teardownNetwork();
    showScreen("menu");
  }
);


/* ----------------------- room code ----------------------- */

function randomRoomCode() {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let s = "";

  for (let i = 0; i < 6; i++) {
    s += chars[
      Math.floor(
        Math.random() * chars.length
      )
    ];
  }

  return s;
}


/* ----------------------- hosting ----------------------- */

function startHostFlow() {
  showScreen("host");

  roomCode = randomRoomCode();

  $("room-code").textContent =
    "Connecting…";

  peer = new Peer(
    "tagged-" + roomCode,
    {
      debug: 1
    }
  );

  mode = "host";

  clientConns.clear();
  players = {};

  peer.on("open", (id) => {
    $("room-code").textContent =
      roomCode;

    localPlayerId = id;

    addPlayer(
      id,
      defaultName("Host")
    );

    renderLobby();

    $("btn-start-hosted").disabled =
      false;

    $("btn-start-hosted").textContent =
      "Start Game";
  });

  peer.on("connection", (conn) => {
    clientConns.set(
      conn.peer,
      conn
    );

    conn.on("open", () => {
      if (!players[conn.peer]) {
        addPlayer(
          conn.peer,
          "Player"
        );
      }

      renderLobby();
      broadcastLobby();

      // If the player joins after the game started,
      // send the current game immediately.
      if (gameRunning) {
        conn.send({
          type: "start",
          platforms
        });

        conn.send({
          type: "state",
          players: sanitizedPlayers(),
          gameEndsAt
        });
      }
    });

    conn.on("data", (msg) => {
      if (typeof msg === "string") {
        try {
          msg = JSON.parse(msg);
        } catch (_) {
          return;
        }
      }

      handleHostMessage(
        conn,
        msg
      );
    });

    conn.on("error", (err) => {
      console.warn(
        "Player connection error:",
        err
      );
    });

    conn.on("close", () => {
      clientConns.delete(
        conn.peer
      );

      delete players[
        conn.peer
      ];

      renderLobby();
      broadcastLobby();
    });
  });

  peer.on("error", (err) => {
    console.error(err);

    if (mode === "host") {
      $("room-code").textContent =
        err.type === "unavailable-id"
          ? "Room busy"
          : "Connection error";

      $("btn-start-hosted").disabled =
        true;
    }
  });

  $("host-name").addEventListener(
    "input",
    () => {
      if (
        localPlayerId &&
        players[localPlayerId]
      ) {
        players[
          localPlayerId
        ].name =
          $("host-name").value.trim() ||
          "Host";

        renderLobby();
        broadcastLobby();
      }
    }
  );

  $("btn-start-hosted").addEventListener(
    "click",
    () => {
      if (
        Object.keys(players).length < 1
      ) {
        return;
      }

      beginGame();

      broadcast({
        type: "start",
        platforms
      });
    },
    {
      once: true
    }
  );
}


/* ----------------------- players ----------------------- */

function addPlayer(id, name) {
  const colorIdx =
    Object.keys(players).length %
    COLORS.length;

  const size = arenaSize();

  players[id] = {
    id,
    name,

    color:
      COLORS[colorIdx],

    x:
      80 +
      Math.random() *
        (size.w - 160),

    y:
      size.h - 200,

    vx: 0,
    vy: 0,

    grounded: false,

    facing: 1,

    isIt: false,

    immuneUntil: 0,

    itTimeMs: 0,

    input: {
      x: 0,
      jump: false
    }
  };
}

function defaultName(fallback) {
  return fallback;
}


/* ----------------------- lobby ----------------------- */

function renderLobby() {
  const wrap =
    $("lobby-players");

  wrap.innerHTML = "";

  Object.values(players)
    .forEach((p) => {
      const row =
        document.createElement(
          "div"
        );

      row.className =
        "lobby-player";

      row.innerHTML = `
        <span
          class="swatch"
          style="background:${p.color}"
        ></span>
        ${p.name}
      `;

      wrap.appendChild(row);
    });
}


/* ----------------------- networking ----------------------- */

function broadcast(msg) {
  clientConns.forEach((conn) => {
    if (conn.open) {
      try {
        conn.send(msg);
      } catch (err) {
        console.warn(
          "Send failed:",
          err
        );
      }
    }
  });
}

function broadcastLobby() {
  broadcast({
    type: "lobby",
    players:
      playersSnapshot()
  });
}

function playersSnapshot() {
  const out = {};

  Object.values(players)
    .forEach((p) => {
      out[p.id] = {
        id: p.id,
        name: p.name,
        color: p.color
      };
    });

  return out;
}

function handleHostMessage(
  conn,
  msg
) {
  if (!msg) return;

  if (msg.type === "input") {
    const p =
      players[conn.peer];

    if (p) {
      p.input =
        msg.vec || {
          x: 0,
          jump: false
        };
    }
  }

  else if (msg.type === "name") {
    const p =
      players[conn.peer];

    if (p) {
      p.name =
        msg.name || "Player";

      renderLobby();

      broadcastLobby();
    }
  }
}


/* ----------------------- joining ----------------------- */

function connectToHost() {
  const nameVal =
    $("join-name").value.trim() ||
    "Player";

  const code =
    $("join-code")
      .value
      .trim()
      .toUpperCase();

  if (!code) {
    $("join-status").textContent =
      "Enter a room code.";

    return;
  }

  $("join-status").textContent =
    "Connecting…";

  mode = "client";

  peer = new Peer(
    undefined,
    {
      debug: 1
    }
  );

  peer.on("open", (id) => {
    localPlayerId = id;

    hostConn =
      peer.connect(
        "tagged-" + code,
        {
          reliable: true
        }
      );

    hostConn.on("open", () => {
      $("join-status").textContent =
        "Connected! Waiting for host to start…";

      hostConn.send({
        type: "name",
        name: nameVal
      });
    });

    hostConn.on("data", (msg) => {
      if (typeof msg === "string") {
        try {
          msg = JSON.parse(msg);
        } catch (_) {
          return;
        }
      }

      handleClientMessage(msg);
    });

    hostConn.on("error", (err) => {
      console.error(
        "Host connection error:",
        err
      );

      $("join-status").textContent =
        "Connection error. Check the room code and try again.";
    });

    hostConn.on("close", () => {
      gameRunning = false;

      showScreen("join");

      $("join-status").textContent =
        "Disconnected from host.";
    });
  });

  peer.on("error", (err) => {
    console.error(err);

    $("join-status").textContent =
      "Couldn't connect. Check the code and try again.";
  });
}


/* ----------------------- client messages ----------------------- */

function handleClientMessage(msg) {
  if (!msg) return;

  if (msg.type === "lobby") {
    // Lobby information.
  }

  else if (msg.type === "start") {
    platforms =
      msg.platforms || [];

    beginGame();
  }

  else if (msg.type === "state") {
    applyStateFromHost(msg);
  }

  else if (msg.type === "gameover") {
    showGameOver(
      msg.results
    );
  }
}

function applyStateFromHost(msg) {
  players =
    msg.players || {};

  gameEndsAt =
    msg.gameEndsAt;
}


/* ----------------------- local 2-player ----------------------- */

function startLocalGame() {
  mode = "local";

  players = {};

  const size =
    arenaSize();

  platforms =
    generatePlatforms(size);

  players["p1"] = {
    id: "p1",
    name: "P1 (WASD)",
    color: COLORS[0],

    x: size.w * 0.3,
    y: size.h - 200,

    vx: 0,
    vy: 0,

    grounded: false,

    facing: 1,

    isIt: true,

    immuneUntil: 0,

    itTimeMs: 0,

    input: {
      x: 0,
      jump: false
    }
  };

  players["p2"] = {
    id: "p2",
    name: "P2 (Arrows)",
    color: COLORS[1],

    x: size.w * 0.7,
    y: size.h - 200,

    vx: 0,
    vy: 0,

    grounded: false,

    facing: -1,

    isIt: false,

    immuneUntil: 0,

    itTimeMs: 0,

    input: {
      x: 0,
      jump: false
    }
  };

  beginGame();
}


/* ----------------------- game loop ----------------------- */

let lastFrameTime = 0;
let lastNetworkSend = 0;

function beginGame() {
  showScreen("game");

  resizeCanvas();

  $("touch-controls")
    .classList
    .toggle(
      "hidden",
      !isTouchDevice()
    );

  if (mode === "host") {
    platforms =
      generatePlatforms(
        arenaSize()
      );
  }

  if (
    mode === "host" ||
    mode === "local"
  ) {
    const ids =
      Object.keys(players);

    if (
      !ids.some(
        (id) =>
          players[id].isIt
      ) &&
      ids.length
    ) {
      players[
        ids[
          Math.floor(
            Math.random() *
              ids.length
          )
        ]
      ].isIt = true;
    }

    gameEndsAt =
      performance.now() +
      GAME_DURATION_MS;
  }

  gameRunning = true;

  lastFrameTime =
    performance.now();

  requestAnimationFrame(
    loop
  );
}

function loop(now) {
  if (!gameRunning) return;

  const dt = Math.min(
    (now - lastFrameTime) / 1000,
    0.05
  );

  lastFrameTime = now;

  if (
    mode === "host" ||
    mode === "local"
  ) {
    hostSimulate(
      dt,
      now
    );
  }

  else if (
    mode === "client"
  ) {
    sendClientInput(now);
  }

  render(now);

  requestAnimationFrame(
    loop
  );
}


/* ----------------------- physics ----------------------- */

function resolvePlatformCollisions(
  p,
  dt
) {
  const halfW =
    PLAYER_W / 2;

  const halfH =
    PLAYER_H / 2;

  const size =
    arenaSize();

  // Horizontal movement
  let newX =
    p.x +
    p.vx * dt;

  newX =
    Math.max(
      halfW,
      Math.min(
        size.w - halfW,
        newX
      )
    );

  const bx1 =
    newX - halfW;

  const bx2 =
    newX + halfW;

  const by1 =
    p.y - halfH;

  const by2 =
    p.y + halfH;

  for (const plat of platforms) {
    const overlapY =
      by1 <
        plat.y + plat.h &&
      by2 >
        plat.y;

    const overlapX =
      bx2 > plat.x &&
      bx1 <
        plat.x + plat.w;

    if (
      overlapY &&
      overlapX
    ) {
      if (p.vx > 0) {
        newX =
          plat.x -
          halfW;
      }

      else if (
        p.vx < 0
      ) {
        newX =
          plat.x +
          plat.w +
          halfW;
      }

      p.vx = 0;

      break;
    }
  }

  p.x = newX;

  // Vertical movement
  let newY =
    p.y +
    p.vy * dt;

  p.grounded = false;

  const bx1b =
    p.x - halfW;

  const bx2b =
    p.x + halfW;

  let by1b =
    newY - halfH;

  let by2b =
    newY + halfH;

  for (const plat of platforms) {
    const overlapX =
      bx2b > plat.x &&
      bx1b <
        plat.x + plat.w;

    const overlapY =
      by1b <
        plat.y + plat.h &&
      by2b >
        plat.y;

    if (
      overlapX &&
      overlapY
    ) {
      if (
        p.vy > 0
      ) {
        newY =
          plat.y -
          halfH;

        p.grounded =
          true;
      }

      else if (
        p.vy < 0
      ) {
        newY =
          plat.y +
          plat.h +
          halfH;
      }

      p.vy = 0;

      by1b =
        newY -
        halfH;

      by2b =
        newY +
        halfH;
    }
  }

  // Bottom fallback
  if (
    newY + halfH >
    size.h
  ) {
    newY =
      size.h -
      halfH;

    p.vy = 0;

    p.grounded =
      true;
  }

  p.y = newY;
}

function stepPlayerPhysics(
  p,
  dt
) {
  const inp =
    p.input || {
      x: 0,
      jump: false
    };

  p.vx =
    inp.x *
    MOVE_SPEED;

  if (
    inp.x !== 0
  ) {
    p.facing =
      inp.x > 0
        ? 1
        : -1;
  }

  p.vy +=
    GRAVITY * dt;

  if (
    p.vy >
    MAX_FALL_SPEED
  ) {
    p.vy =
      MAX_FALL_SPEED;
  }

  if (
    inp.jump &&
    p.grounded
  ) {
    p.vy =
      JUMP_VELOCITY;

    p.grounded =
      false;
  }

  resolvePlatformCollisions(
    p,
    dt
  );

  if (p.isIt) {
    p.itTimeMs +=
      dt * 1000;
  }

  // Consume jump input after simulation
  if (p.input) {
    p.input.jump =
      false;
  }
}


/* ----------------------- host simulation ----------------------- */

function hostSimulate(
  dt,
  now
) {
  if (
    mode === "host" &&
    players[localPlayerId]
  ) {
    players[
      localPlayerId
    ].input =
      readSoloInput();
  }

  if (mode === "local") {
    players["p1"].input =
      readWASDInput();

    players["p2"].input =
      readArrowInput();
  }

  Object.values(players)
    .forEach((p) =>
      stepPlayerPhysics(
        p,
        dt
      )
    );

  // Tag detection
  const list =
    Object.values(players);

  const itPlayer =
    list.find(
      (p) => p.isIt
    );

  if (
    itPlayer &&
    now >
      lastTagAt + 50
  ) {
    for (
      const other of list
    ) {
      if (
        other.id ===
        itPlayer.id
      ) {
        continue;
      }

      if (
        now <
        other.immuneUntil
      ) {
        continue;
      }

      const dist =
        Math.hypot(
          other.x -
            itPlayer.x,
          other.y -
            itPlayer.y
        );

      if (
        dist <
        TAG_DISTANCE
      ) {
        itPlayer.isIt =
          false;

        other.isIt =
          true;

        other.immuneUntil =
          0;

        itPlayer.immuneUntil =
          now +
          TAG_COOLDOWN_MS;

        lastTagAt =
          now;

        break;
      }
    }
  }

  const msLeft =
    gameEndsAt -
    now;

  $("hud-timer").textContent =
    formatTime(
      Math.max(
        0,
        msLeft
      )
    );

  $("hud-status").textContent =
    itPlayer
      ? `${itPlayer.name} is IT`
      : "";

  $("hud-scores").textContent =
    list
      .map(
        (p) =>
          p.name.split(" ")[0]
      )
      .join(" · ");

  if (
    msLeft <= 0
  ) {
    endGame();
    return;
  }

  if (
    mode === "host" &&
    now -
      lastNetworkSend >
      NETWORK_TICK_MS
  ) {
    lastNetworkSend =
      now;

    broadcast({
      type: "state",

      players:
        sanitizedPlayers(),

      gameEndsAt
    });
  }
}

function sanitizedPlayers() {
  const out = {};

  Object.values(players)
    .forEach((p) => {
      const {
        input,
        ...rest
      } = p;

      out[p.id] =
        rest;
    });

  return out;
}


/* ----------------------- client input ----------------------- */

function sendClientInput(
  now
) {
  if (
    !hostConn ||
    !hostConn.open
  ) {
    return;
  }

  if (
    now -
      lastNetworkSend >
    NETWORK_TICK_MS
  ) {
    lastNetworkSend =
      now;

    hostConn.send({
      type: "input",

      vec:
        readSoloInput()
    });
  }

  const msLeft =
    gameEndsAt -
    now;

  $("hud-timer").textContent =
    formatTime(
      Math.max(
        0,
        msLeft
      )
    );

  const itPlayer =
    Object.values(players)
      .find(
        (p) => p.isIt
      );

  $("hud-status").textContent =
    itPlayer
      ? `${itPlayer.name} is IT`
      : "";

  $("hud-scores").textContent =
    Object.values(players)
      .map(
        (p) =>
          p.name.split(" ")[0]
      )
      .join(" · ");
}


/* ----------------------- timer ----------------------- */

function formatTime(ms) {
  const total =
    Math.ceil(
      ms / 1000
    );

  const m =
    Math.floor(
      total / 60
    );

  const s =
    total % 60;

  return `${m}:${s
    .toString()
    .padStart(2, "0")}`;
}


/* ----------------------- game over ----------------------- */

function endGame() {
  gameRunning =
    false;

  const results =
    Object.values(players)
      .map((p) => ({
        name: p.name,
        itTimeMs:
          p.itTimeMs
      }))
      .sort(
        (a, b) =>
          a.itTimeMs -
          b.itTimeMs
      );

  if (
    mode === "host"
  ) {
    broadcast({
      type: "gameover",
      results
    });
  }

  showGameOver(
    results
  );
}

function showGameOver(
  results
) {
  gameRunning =
    false;

  showScreen(
    "gameover"
  );

  const wrap =
    $("gameover-results");

  wrap.innerHTML = "";

  results.forEach(
    (r, i) => {
      const row =
        document.createElement(
          "div"
        );

      row.className =
        "result-row";

      const secs =
        (
          r.itTimeMs /
          1000
        ).toFixed(1);

      row.innerHTML = `
        <span>
          #${i + 1}
          ${r.name}
        </span>

        <span>
          ${secs}s as IT
        </span>
      `;

      wrap.appendChild(
        row
      );
    }
  );
}


/* ----------------------- rendering ----------------------- */

function render(now) {
  const size =
    arenaSize();

  ctx.clearRect(
    0,
    0,
    size.w,
    size.h
  );

  // Background
  const grad =
    ctx.createLinearGradient(
      0,
      0,
      0,
      size.h
    );

  grad.addColorStop(
    0,
    "#201c33"
  );

  grad.addColorStop(
    1,
    "#2a2444"
  );

  ctx.fillStyle =
    grad;

  ctx.fillRect(
    0,
    0,
    size.w,
    size.h
  );

  // Platforms
  platforms.forEach(
    (plat) => {
      ctx.fillStyle =
        "#3a3458";

      ctx.fillRect(
        plat.x,
        plat.y,
        plat.w,
        plat.h
      );

      ctx.fillStyle =
        "#5de4c7";

      ctx.fillRect(
        plat.x,
        plat.y,
        plat.w,
        4
      );
    }
  );

  // Players
  Object.values(players)
    .forEach((p) => {
      const halfW =
        PLAYER_W / 2;

      const halfH =
        PLAYER_H / 2;

      ctx.save();

      if (p.isIt) {
        ctx.shadowColor =
          "#ff5d6c";

        ctx.shadowBlur =
          22;
      }

      ctx.fillStyle =
        p.isIt
          ? "#ff5d6c"
          : p.color;

      roundRect(
        ctx,

        p.x - halfW,
        p.y - halfH,

        PLAYER_W,
        PLAYER_H,

        8
      );

      ctx.fill();

      if (
        now <
        (p.immuneUntil || 0)
      ) {
        ctx.lineWidth =
          3;

        ctx.strokeStyle =
          "rgba(255,255,255,0.6)";

        ctx.stroke();
      }

      ctx.restore();

      // Eyes
      ctx.fillStyle =
        "#14121f";

      const eyeX =
        p.x +
        (p.facing || 1) *
          6;

      ctx.beginPath();

      ctx.arc(
        eyeX,
        p.y - 8,
        3,
        0,
        Math.PI * 2
      );

      ctx.fill();

      // Name
      ctx.fillStyle =
        "#f4f2ff";

      ctx.font =
        "13px sans-serif";

      ctx.textAlign =
        "center";

      ctx.fillText(
        p.name,
        p.x,
        p.y -
          halfH -
          10
      );

      if (p.isIt) {
        ctx.fillStyle =
          "#ff5d6c";

        ctx.font =
          "bold 11px sans-serif";

        ctx.fillText(
          "IT",
          p.x,
          p.y -
            halfH -
            24
        );
      }
    });
}


/* ----------------------- rounded rectangle ----------------------- */

function roundRect(
  ctx,
  x,
  y,
  w,
  h,
  r
) {
  ctx.beginPath();

  ctx.moveTo(
    x + r,
    y
  );

  ctx.arcTo(
    x + w,
    y,
    x + w,
    y + h,
    r
  );

  ctx.arcTo(
    x + w,
    y + h,
    x,
    y + h,
    r
  );

  ctx.arcTo(
    x,
    y + h,
    x,
    y,
    r
  );

  ctx.arcTo(
    x,
    y,
    x + w,
    y,
    r
  );

  ctx.closePath();
}


/* ----------------------- cleanup ----------------------- */

function teardownNetwork() {
  gameRunning =
    false;

  Object.keys(keys)
    .forEach(
      (k) =>
        (keys[k] = false)
    );

  jumpQueue.p1 =
    jumpQueue.p2 =
    jumpQueue.solo =
      false;

  if (hostConn) {
    try {
      hostConn.close();
    } catch (e) {}

    hostConn = null;
  }

  clientConns.forEach(
    (c) => {
      try {
        c.close();
      } catch (e) {}
    }
  );

  clientConns.clear();

  if (peer) {
    try {
      peer.destroy();
    } catch (e) {}

    peer = null;
  }

  players = {};
  mode = null;
}
