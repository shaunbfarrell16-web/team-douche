// Team Douche leaderboard - shared logic. Storage is Netlify Blobs.
//
// Keys:
//   player/<id>      one entry per player (with a private edit token)
//   game/<id>        one entry per game
//   month/<YYYY-MM>  { matches: [...], gotm: gameId|null }
//
// Scoring: every finish scores 0-100. 1st = 100, last = 0, scaled to the
// size of the match (4th of 12 = 73). Your rating is your AVERAGE score,
// so playing more matches doesn't help - playing better does.
// You need MIN_MATCHES matches to qualify for a crown.

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
const ord = (n) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const newId = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
const newToken = () => Array.from({ length: 4 }, () => Math.random().toString(36).slice(2)).join("");

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const fail = (msg, status = 400) => json({ error: msg }, status);

const emptyMonth = () => ({ matches: [], gotm: null });
const norm = (m) => ({ matches: [], gotm: null, ...(m || {}) });

// ---------- scoring ----------
// Turns one match into { playerId: { rank, score, win } }.
export function scoreMatch(match) {
  const res = match.results;
  const k = res.length;
  const F = match.field && match.field >= k ? match.field : k;
  const out = {};
  if (match.field) {
    // Real finishing positions out of the whole lobby (randoms/CPUs included).
    for (const r of res) {
      const tied = res.filter((x) => x.pos === r.pos).length;
      const rank = Math.min(F, r.pos + (tied - 1) / 2);
      out[r.playerId] = { pos: r.pos, rank, score: F > 1 ? (100 * (F - rank)) / (F - 1) : 0, win: r.pos === 1 };
    }
  } else {
    // Just us: positions are only used for order. Ties share the average place.
    const sorted = [...res].sort((a, b) => a.pos - b.pos);
    const best = sorted[0].pos;
    const allTied = sorted[k - 1].pos === best; // a straight draw isn't a win for anyone
    let i = 0;
    while (i < k) {
      let j = i;
      while (j + 1 < k && sorted[j + 1].pos === sorted[i].pos) j++;
      const rank = (i + 1 + (j + 1)) / 2;
      for (let x = i; x <= j; x++) {
        out[sorted[x].playerId] = { pos: i + 1, rank, score: k > 1 ? (100 * (k - rank)) / (k - 1) : 0, win: sorted[x].pos === best && !allTied, draw: allTied };
      }
      i = j + 1;
    }
  }
  return out;
}

// Ratings for a month: per player overall, and per player per game.
export function statsFor(m, min) {
  const players = {}; // pid -> { played, wins, total }
  const games = {};   // gid -> pid -> { played, wins, total, posTotal }
  for (const match of norm(m).matches) {
    const s = scoreMatch(match);
    games[match.gameId] ||= {};
    for (const [pid, r] of Object.entries(s)) {
      const p = (players[pid] ||= { played: 0, wins: 0, total: 0 });
      const g = (games[match.gameId][pid] ||= { played: 0, wins: 0, total: 0, posTotal: 0 });
      p.played++; g.played++;
      p.total += r.score; g.total += r.score;
      g.posTotal += r.rank;
      if (r.win) { p.wins++; g.wins++; }
    }
  }
  const finish = (o) => {
    o.rating = o.played ? Math.round((o.total / o.played) * 10) / 10 : 0;
    o.qualified = o.played >= min;
    if (o.posTotal !== undefined) o.avgPos = Math.round((o.posTotal / o.played) * 10) / 10;
    delete o.total; delete o.posTotal;
    return o;
  };
  Object.values(players).forEach(finish);
  Object.values(games).forEach((row) => Object.values(row).forEach(finish));

  const top = (row) => {
    const q = Object.entries(row).filter(([, s]) => s.qualified);
    if (!q.length) return [];
    const best = Math.max(...q.map(([, s]) => s.rating));
    return q.filter(([, s]) => s.rating === best).map(([pid]) => pid);
  };
  const byGame = {};
  for (const [gid, row] of Object.entries(games)) {
    const t = top(row);
    if (t.length) byGame[gid] = t;
  }
  return { players, games, overall: top(players), byGame, matchCount: norm(m).matches.length };
}

async function listJson(store, prefix) {
  const { blobs } = await store.list({ prefix });
  const all = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return all.filter(Boolean);
}

// Read-modify-write that won't lose a result if two people save at once.
async function update(store, key, fn) {
  for (let i = 0; i < 8; i++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    const data = norm(cur ? cur.data : emptyMonth());
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
  const MIN = Math.max(1, parseInt(env.MIN_MATCHES, 10) || 3);

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
          await Promise.all(months.map(async (k) => [k, norm(await store.get(`month/${k}`, { type: "json" }))]))
        );
        const m = monthData[month] || emptyMonth();
        const prev = shiftMonth(month, -1);

        const hall = months
          .filter((k) => k < now)
          .map((k) => ({ month: k, gotm: monthData[k].gotm, ...statsFor(monthData[k], MIN) }))
          .filter((h) => h.overall.length || Object.keys(h.byGame).length)
          .reverse();

        return json({
          now,
          month,
          finished: month < now,
          min: MIN,
          adminEnabled: Boolean(env.ADMIN_PIN),
          players: players.map(({ token, ...p }) => p).sort((a, b) => a.name.localeCompare(b.name)),
          games: games.sort((a, b) => a.name.localeCompare(b.name)),
          gotm: m.gotm,
          matches: [...m.matches].reverse().slice(0, 40).map((x) => ({ ...x, scored: scoreMatch(x) })),
          stats: statsFor(m, MIN),
          reigning: { month: prev, ...statsFor(monthData[prev], MIN) }, // last month's champs wear badges this month
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

      // ---------- MATCHES ----------
      if (route === "match") {
        const month = validMonth(body.month) ? body.month : now;
        if (month !== now && !admin) return fail("That month's done - only the admin can change it.", 403);

        if (req.method === "POST") {
          const gameId = clean(body.gameId, 20);
          if (!(await store.get(`game/${gameId}`, { type: "json" }))) return fail("Pick a game.");
          const field = body.field ? parseInt(body.field, 10) : null;
          if (field !== null && (!(field >= 2) || field > 200)) return fail("Players in the match should be between 2 and 200.");

          const seen = new Set();
          const results = [];
          for (const r of Array.isArray(body.results) ? body.results : []) {
            const playerId = clean(r.playerId, 20);
            const pos = parseInt(r.pos, 10);
            if (!playerId || seen.has(playerId) || !(pos >= 1)) continue;
            seen.add(playerId);
            results.push({ playerId, pos });
          }
          if (!results.length) return fail("Add at least one player's finish.");
          if (!field && results.length < 2) return fail("Add at least two of the squad, or enter how many were in the match.");
          if (field && results.length > field) return fail(`You've got ${results.length} players but said the match had ${field}.`);
          if (field && results.some((r) => r.pos > field)) return fail(`Nobody can finish lower than ${ord(field)}.`);
          if (results.length > 30) return fail("That's too many players.");

          const players = await Promise.all(results.map((r) => store.get(`player/${r.playerId}`, { type: "json" })));
          if (players.some((p) => !p)) return fail("One of those players doesn't exist any more - refresh the page.");

          const match = { id: newId(), at: new Date().toISOString(), gameId, field, results };
          const res = await update(store, `month/${month}`, (m) => { m.matches.push(match); });
          if (res.error) return fail(res.error);
          return json({ ok: true, match: { ...match, scored: scoreMatch(match) } });
        }

        if (req.method === "DELETE") {
          const id = clean(body.id, 20);
          let found = false;
          const res = await update(store, `month/${month}`, (m) => {
            const before = m.matches.length;
            m.matches = m.matches.filter((x) => x.id !== id);
            found = m.matches.length !== before;
            if (!found) return { error: "Match not found." };
          });
          if (res.error) return fail(res.error, found ? 400 : 404);
          return json({ ok: true });
        }
      }

      // ---------- GAME OF THE MONTH ----------
      if (route === "gotm" && req.method === "POST") {
        const month = validMonth(body.month) ? body.month : now;
        if (month < now && !admin) return fail("That month's done - only the admin can change it.", 403);
        const gameId = body.gameId ? clean(body.gameId, 20) : null;
        if (gameId && !(await store.get(`game/${gameId}`, { type: "json" }))) return fail("Pick a game.");
        const res = await update(store, `month/${month}`, (m) => { m.gotm = gameId; });
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
