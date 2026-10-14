// Team Douche leaderboard - shared logic. Storage is Netlify Blobs.
//
// Keys:
//   player/<id>   one entry per player (with a private edit token)
//   game/<id>     one entry per game
//   month/<YYYY-MM>  { wins: {gameId: {playerId: n}}, gotm: gameId|null, log: [...] }

const TZ = "Europe/London";

export const monthKey = (d = new Date()) => {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit" }).formatToParts(d);
  return `${p.find((x) => x.type === "year").value}-${p.find((x) => x.type === "month").value}`;
};
export const shiftMonth = (key, n) => {
  let [y, m] = key.split("-").map(Number);
  m += n;
  while (m < 1) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  return `${y}-${String(m).padStart(2, "0")}`;
};
const validMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ""));

const clean = (v, max) => String(v ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const cleanEmoji = (v, fallback) => clean(v, 8) || fallback;
const newId = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
const newToken = () => Array.from({ length: 4 }, () => Math.random().toString(36).slice(2)).join("");

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const fail = (msg, status = 400) => json({ error: msg }, status);

const emptyMonth = () => ({ wins: {}, gotm: null, log: [] });

// Who won a month: per game (most wins, ties share it) and overall.
export const champsFor = (m) => {
  const byGame = {};
  const totals = {};
  for (const [gid, row] of Object.entries(m?.wins || {})) {
    let best = 0;
    for (const [pid, n] of Object.entries(row)) {
      totals[pid] = (totals[pid] || 0) + n;
      if (n > best) best = n;
    }
    if (best > 0) byGame[gid] = Object.keys(row).filter((p) => row[p] === best);
  }
  const top = Math.max(0, ...Object.values(totals));
  const overall = top > 0 ? Object.keys(totals).filter((p) => totals[p] === top) : [];
  return { byGame, overall, totals };
};

async function listJson(store, prefix) {
  const { blobs } = await store.list({ prefix });
  const all = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return all.filter(Boolean);
}

// Read-modify-write that won't lose a win if two people tap at once.
async function update(store, key, fn, fallback) {
  for (let i = 0; i < 8; i++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    const data = cur ? cur.data : fallback();
    const out = fn(data);
    if (out && out.error) return out;
    const res = await store.setJSON(key, data, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (res.modified !== false) return { data };
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 120));
  }
  return { error: "Busy - try again." };
}

export function makeHandler(getStore, env = process.env) {
  const isAdmin = (pin) => Boolean(env.ADMIN_PIN) && String(pin || "") === String(env.ADMIN_PIN);

  return async (req) => {
    const store = getStore();
    const url = new URL(req.url);
    const route = url.pathname.replace(/^.*\/api\/?/, "").replace(/\/$/, "");
    const now = monthKey();

    try {
      // ---------- READ EVERYTHING ----------
      if (req.method === "GET" && (route === "state" || route === "")) {
        const month = validMonth(url.searchParams.get("month")) ? url.searchParams.get("month") : now;
        const [players, games, monthList] = await Promise.all([
          listJson(store, "player/"),
          listJson(store, "game/"),
          store.list({ prefix: "month/" }),
        ]);
        const months = monthList.blobs.map((b) => b.key.slice(6)).sort();
        const monthData = Object.fromEntries(
          await Promise.all(months.map(async (k) => [k, (await store.get(`month/${k}`, { type: "json" })) || emptyMonth()]))
        );
        const m = monthData[month] || emptyMonth();
        const prev = shiftMonth(month, -1);

        // Hall of fame: every finished month that had wins.
        const hall = months
          .filter((k) => k < now)
          .map((k) => ({ month: k, gotm: monthData[k].gotm, ...champsFor(monthData[k]) }))
          .filter((h) => h.overall.length)
          .reverse();

        return json({
          now,
          month,
          finished: month < now,
          adminEnabled: Boolean(env.ADMIN_PIN),
          players: players.map(({ token, ...p }) => p).sort((a, b) => a.name.localeCompare(b.name)),
          games: games.sort((a, b) => a.name.localeCompare(b.name)),
          wins: m.wins,
          gotm: m.gotm,
          log: m.log.slice(0, 25),
          standings: champsFor(m),
          reigning: { month: prev, ...champsFor(monthData[prev]) }, // last month's champs wear badges this month
          hall,
        });
      }

      let body = {};
      if (req.method !== "GET") {
        try { body = await req.json(); } catch { return fail("Bad request"); }
      }
      const admin = isAdmin(body.pin);

      if (route === "admin" && req.method === "POST") {
        if (!env.ADMIN_PIN) return fail("No admin PIN has been set up yet.", 403);
        return admin ? json({ ok: true }) : fail("Wrong PIN.", 403);
      }

      // ---------- PLAYERS ----------
      if (route === "player") {
        const fields = () => ({
          name: clean(body.name, 24),
          gamertag: clean(body.gamertag, 32),
          platform: clean(body.platform, 20),
          favGame: clean(body.favGame, 32),
          motto: clean(body.motto, 80),
          avatar: cleanEmoji(body.avatar, "😎"),
        });

        if (req.method === "POST") {
          const p = fields();
          if (!p.name) return fail("Give yourself a name.");
          const existing = await listJson(store, "player/");
          if (existing.some((e) => e.name.toLowerCase() === p.name.toLowerCase())) return fail("That name's taken.");
          const player = { id: newId(), ...p, joined: new Date().toISOString(), token: newToken() };
          await store.setJSON(`player/${player.id}`, player);
          const { token, ...pub } = player;
          return json({ player: pub, token });
        }

        const id = clean(body.id, 20);
        const cur = id && (await store.get(`player/${id}`, { type: "json" }));
        if (!cur) return fail("Player not found.", 404);
        if (!admin && body.token !== cur.token) return fail("You can only edit your own profile.", 403);

        if (req.method === "PUT") {
          const p = fields();
          if (!p.name) return fail("Name can't be blank.");
          const others = await listJson(store, "player/");
          if (others.some((e) => e.id !== id && e.name.toLowerCase() === p.name.toLowerCase())) return fail("That name's taken.");
          await store.setJSON(`player/${id}`, { ...cur, ...p });
          return json({ ok: true });
        }
        if (req.method === "DELETE") {
          await store.delete(`player/${id}`);
          return json({ ok: true });
        }
      }

      // ---------- GAMES ----------
      if (route === "game") {
        if (req.method === "POST") {
          const name = clean(body.name, 32);
          if (!name) return fail("Name the game.");
          const games = await listJson(store, "game/");
          if (games.some((g) => g.name.toLowerCase() === name.toLowerCase())) return fail("That game's already on the list.");
          const game = { id: newId(), name, icon: cleanEmoji(body.icon, "🎮") };
          await store.setJSON(`game/${game.id}`, game);
          return json({ game });
        }
        if (req.method === "DELETE") {
          if (env.ADMIN_PIN && !admin) return fail("Only the admin can delete games.", 403);
          await store.delete(`game/${clean(body.id, 20)}`);
          return json({ ok: true });
        }
      }

      // ---------- WINS ----------
      if (route === "win" && req.method === "POST") {
        const month = validMonth(body.month) ? body.month : now;
        if (month !== now && !admin) return fail("That month's done - only the admin can change it.", 403);
        const gameId = clean(body.gameId, 20);
        const playerId = clean(body.playerId, 20);
        const delta = Number(body.delta) === -1 ? -1 : 1;
        const [game, player] = await Promise.all([
          store.get(`game/${gameId}`, { type: "json" }),
          store.get(`player/${playerId}`, { type: "json" }),
        ]);
        if (!game) return fail("Pick a game.");
        if (!player) return fail("Pick a player.");

        const res = await update(store, `month/${month}`, (m) => {
          m.wins[gameId] ||= {};
          const n = (m.wins[gameId][playerId] || 0) + delta;
          if (n < 0) return { error: "Can't go below zero." };
          if (n === 0) delete m.wins[gameId][playerId];
          else m.wins[gameId][playerId] = n;
          m.log.unshift({ at: new Date().toISOString(), gameId, playerId, delta });
          m.log = m.log.slice(0, 60);
        }, emptyMonth);
        if (res.error) return fail(res.error);
        return json({ ok: true, count: res.data.wins[gameId]?.[playerId] || 0 });
      }

      // ---------- GAME OF THE MONTH ----------
      if (route === "gotm" && req.method === "POST") {
        const month = validMonth(body.month) ? body.month : now;
        if (month < now && !admin) return fail("That month's done - only the admin can change it.", 403);
        const gameId = body.gameId ? clean(body.gameId, 20) : null;
        if (gameId && !(await store.get(`game/${gameId}`, { type: "json" }))) return fail("Pick a game.");
        const res = await update(store, `month/${month}`, (m) => { m.gotm = gameId; }, emptyMonth);
        if (res.error) return fail(res.error);
        return json({ ok: true });
      }

      return fail("Not found", 404);
    } catch (e) {
      console.error(e);
      return fail("Server error - try again.", 500);
    }
  };
}
