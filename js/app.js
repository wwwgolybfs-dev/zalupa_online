"use strict";
/* =========================================================================
   КТО РУИНА? — разбор поражения в Dota 2 по Match ID.
   Zero dependencies: открывается как файл и работает на GitHub Pages.
   Данные: OpenDota API (https://docs.opendota.com).

   Важный принцип: сервис не выдумывает данные. Если матч не разобран
   OpenDota (нет lane/таймлайна/драк), интерфейс честно показывает, что
   разбор опирается только на итоговую статистику, и снижает надёжность.
   ========================================================================= */

/* ------------------------------- конфигурация ------------------------------ */
const API = "https://api.opendota.com/api";
// Мосты к OpenDota (см. bridge/README.md). Порядок = приоритет:
// сначала Supabase, затем Cloudflare, потом прямой запрос к OpenDota.
// Пустая строка означает «мост не настроен» — он просто пропускается,
// поэтому сайт полностью работоспособен и без них.
const BRIDGE_SUPABASE = "";
const BRIDGE_CLOUDFLARE = "https://kto-ruina-bridge.wwwgolybfs.workers.dev";
// Если мост не ответил за это время — сразу откатываемся ниже, а не ждём минуту.
const BRIDGE_TIMEOUT = 25000;
const OPENDOTA_MATCH = "https://www.opendota.com/matches";
const T = { match: 60000, request: 15000, poll: 20000 };
const PARSE_POLL = { interval: 10000, attempts: 18 };  // ~3 минуты ожидания парсинга
const IS_BROWSER = typeof document !== "undefined" && typeof window !== "undefined";

// Герои, предметы и ранги приходят из data/*.js (локальные ассеты, см. tools/fetch-assets.py),
// поэтому сайт не ходит за картинками на Steam CDN — всё лежит в репозитории.
let HEROES = {}, ITEMS = {}, RANK_ICONS = [];

/* --------------------------------- утилиты -------------------------------- */
const $ = id => document.getElementById(id);
const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));
const fmt = n => (Number(n) || 0).toLocaleString("ru-RU");
const time = s => `${Math.floor((Number(s) || 0) / 60)}:${String(Math.floor((Number(s) || 0) % 60)).padStart(2, "0")}`;
const esc = s => String(s ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]));
const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const id = setTimeout(() => { cleanup(); resolve(); }, ms);
  const onAbort = () => { cleanup(); reject(new Error("Отменено")); };
  function cleanup() { clearTimeout(id); signal && signal.removeEventListener("abort", onAbort); }
  signal && signal.addEventListener("abort", onAbort, { once: true });
});

/* --------------------------- сеть: таймауты и повторы --------------------- */
async function fetchJSON(url, opts = {}) {
  const { timeout = 20000, retries = 1, method = "GET", signal = null, fresh = false } = opts;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal && signal.aborted) throw new Error("Отменено");
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal && signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort("timeout"), timeout);
    try {
      // fresh: не отдавать данные из кеша браузера — важно для повторного
      // опроса матча после запроса парсинга. Проверено: preflight OpenDota
      // разрешает заголовки cache-control/pragma.
      const init = { method, signal: ctrl.signal, mode: "cors" };
      if (fresh) init.cache = "no-store";
      const res = await fetch(url, init);
      if (!res.ok) {
        const err = new Error(res.status === 429
          ? "OpenDota ограничил частоту запросов. Подожди минуту и повтори."
          : res.status === 404 ? "Матч не найден в OpenDota."
            : `OpenDota ответил HTTP ${res.status}.`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (signal && signal.aborted) throw new Error("Отменено");
      if (err.status === 404 || err.status === 429) throw err;
      if (ctrl.signal.aborted) lastErr = new Error("OpenDota не ответил вовремя.");
      if (attempt < retries) { try { await sleep(1200 * (attempt + 1), signal); } catch (e) { throw new Error("Отменено"); } }
    } finally {
      clearTimeout(timer);
      signal && signal.removeEventListener("abort", onAbort);
    }
  }
  throw lastErr || new Error("Не удалось получить данные.");
}

/* Запрос к OpenDota через мосты с откатом: Supabase → Cloudflare → напрямую.
   path — без ведущего слэша, например "matches/123456". */
async function apiFetch(path, opts = {}) {
  const direct = () => fetchJSON(`${API}/${path}`, opts);
  for (const base of [BRIDGE_SUPABASE, BRIDGE_CLOUDFLARE]) {
    if (!base) continue;
    try {
      // retries: 0 и короткий таймаут — чтобы нерабочий мост не тормозил разбор
      return await fetchJSON(`${base}/${path}`, { ...opts, timeout: BRIDGE_TIMEOUT, retries: 0 });
    } catch (err) {
      if (err && err.message === "Отменено") throw err;
      // мост не ответил — пробуем следующий уровень
    }
  }
  return direct();
}

/* Кеш конкретного матча: повторное открытие не тратит лимит OpenDota. */
const MATCH_CACHE_TTL = 15 * 60 * 1000; // 15 минут
function readMatchCache(id) {
  try {
    const raw = localStorage.getItem(`wr:match:${id}`);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || !d.m || Date.now() - d.ts > MATCH_CACHE_TTL) return null;
    return d;
  } catch (e) { return null; }
}
function writeMatchCache(id, m) {
  try { localStorage.setItem(`wr:match:${id}`, JSON.stringify({ m, ts: Date.now() })); }
  catch (e) { /* квота localStorage — просто не кешируем */ }
}

/* История последних разборов (для быстрого повторного открытия). */
const HISTORY_KEY = "wr:history";
function readHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch (e) { return []; }
}
function writeHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 8))); } catch (e) { }
}
function pushHistory(entry) {
  const list = readHistory().filter(x => String(x.id) !== String(entry.id));
  list.unshift(entry);
  writeHistory(list);
}
function setConstants(heroes, items, ranks) { HEROES = heroes || {}; ITEMS = items || {}; if (ranks) RANK_ICONS = ranks; }

/* ------------------------------ справочники ------------------------------- */
function teamOf(p) { return Number(p.player_slot) < 128 ? "Radiant" : "Dire"; }
function heroData(p) { return HEROES[String(p.hero_id)] || {}; }
function heroName(p) { return heroData(p).name || `Герой #${p.hero_id}`; }
function heroImg(p) {
  const h = heroData(p);
  if (h.img) return h.img;
  const slug = String(h.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return slug ? `assets/heroes/${slug}.png` : "";
}
function itemData(id) { return ITEMS[String(id)] || {}; }
function itemImg(id) { return itemData(id).img || ""; }
function itemName(id) { return itemData(id).name || "Предмет"; }
/* Элемент сборки: если путь картинки известен — картинка, иначе видимый
   плейсхолдер с номером предмета (раньше был пустой src → ничего). */
function itemFallback(img) {
  const s = document.createElement("span");
  s.className = "itemFallback";
  s.title = (img && img.dataset && img.dataset.name) || "";
  s.textContent = (img && img.dataset && img.dataset.fallback) || "?";
  return s;
}
function itemHtml(id) {
  const it = itemData(id);
  if (it.img) {
    const name = it.name || `#${id}`;
    return `<img class="itemIcon" src="${it.img}" alt="${esc(name)}" title="${esc(name)}" loading="lazy" data-name="${esc(name)}" data-fallback="${esc("#" + id)}" onerror="this.replaceWith(itemFallback(this))">`;
  }
  return `<span class="itemFallback" title="Предмет #${id}">#${id}</span>`;
}
function rankName(t) {
  const n = Number(t || 0), medal = Math.floor(n / 10), stars = n % 10;
  const name = ({ 1: "Herald", 2: "Guardian", 3: "Crusader", 4: "Archon", 5: "Legend", 6: "Ancient", 7: "Divine", 8: "Immortal" })[medal] || "Без ранга";
  return stars ? `${name} ${stars}` : name;
}
function rankImg(t) {
  const medal = Math.floor(Number(t || 0) / 10);
  return medal && RANK_ICONS[medal - 1] ? RANK_ICONS[medal - 1] : "";
}
function itemsOf(p) {
  return [0, 1, 2, 3, 4, 5].map(k => p[`item_${k}`])
    .concat([0, 1, 2].map(k => p[`backpack_${k}`]))
    .concat([p.item_neutral])
    .filter(Boolean);
}

/* -------------------------------- роли POS -------------------------------- */
/* OpenDota lane_role — это категория линии, а не POS 1-5:
   1 = safe, 2 = mid, 3 = offlane, 4 = jungle/other.
   Сначала используем линию, затем добиваем недостающие позиции
   ресурсными сигналами, чтобы интерфейс всегда показывал POS 1-5. */
function inferRoles(team) {
  const value = x => (x.net_worth || 0) * .55 + (x.gold_per_min || 0) * .25 + (x.last_hits || 0) * .12 + (x.xp_per_min || 0) * .08;
  const lane = x => Number(x.lane_role || 0);
  const assigned = new Map();

  const mid = team.filter(x => lane(x) === 2).sort((a, b) => value(b) - value(a));
  if (mid.length) assigned.set(mid[0].player_slot, { position: 2, role: "Pos 2 · Mid", confidence: 99, source: "OpenDota lane_role" });

  const safe = team.filter(x => lane(x) === 1).sort((a, b) => value(b) - value(a));
  if (safe.length >= 2) {
    assigned.set(safe[0].player_slot, { position: 1, role: "Pos 1 · Carry", confidence: 96, source: "OpenDota safe lane + ресурсы" });
    assigned.set(safe[1].player_slot, { position: 5, role: "Pos 5 · Hard Support", confidence: 96, source: "OpenDota safe lane + ресурсы" });
  } else if (safe.length === 1) {
    const p = safe[0];
    const rest = team.filter(x => lane(x) !== 2).sort((a, b) => value(b) - value(a));
    const isCore = value(p) >= value(rest[Math.min(2, rest.length - 1)] || p);
    assigned.set(p.player_slot, { position: isCore ? 1 : 5, role: isCore ? "Pos 1 · Carry" : "Pos 5 · Hard Support", confidence: 78, source: "OpenDota safe lane + fallback" });
  }

  const off = team.filter(x => lane(x) === 3).sort((a, b) => value(b) - value(a));
  if (off.length >= 2) {
    assigned.set(off[0].player_slot, { position: 3, role: "Pos 3 · Offlane", confidence: 96, source: "OpenDota offlane + ресурсы" });
    assigned.set(off[1].player_slot, { position: 4, role: "Pos 4 · Soft Support", confidence: 96, source: "OpenDota offlane + ресурсы" });
  } else if (off.length === 1) {
    const p = off[0];
    const rest = team.filter(x => lane(x) !== 2).sort((a, b) => value(b) - value(a));
    const isCore = value(p) >= value(rest[Math.min(1, rest.length - 1)] || p);
    assigned.set(p.player_slot, { position: isCore ? 3 : 4, role: isCore ? "Pos 3 · Offlane" : "Pos 4 · Soft Support", confidence: 78, source: "OpenDota offlane + fallback" });
  }

  const used = new Set([...assigned.values()].map(x => x.position));
  const missing = [1, 2, 3, 4, 5].filter(x => !used.has(x));
  const remaining = team.filter(p => !assigned.has(p.player_slot)).sort((a, b) => value(b) - value(a));
  for (const pos of missing) {
    const p = remaining.shift();
    if (!p) break;
    const data = {
      1: ["Pos 1 · Carry", 62], 2: ["Pos 2 · Mid", 70], 3: ["Pos 3 · Offlane", 62],
      4: ["Pos 4 · Soft Support", 58], 5: ["Pos 5 · Hard Support", 58]
    }[pos];
    assigned.set(p.player_slot, { position: pos, role: data[0], confidence: data[1], source: "fallback по статистике" });
  }

  return Object.fromEntries(team.map(p => [p.player_slot, assigned.get(p.player_slot) || { position: 5, role: "Pos 5 · Hard Support", confidence: 40, source: "fallback" }]));
}
function inferRole(p, team) {
  return inferRoles(team)[p.player_slot] || { position: 5, role: "Pos 5 · Hard Support", confidence: 40, source: "fallback" };
}
function roleWeights(role) {
  const pos = Number(String(role || "").match(/Pos (\d)/)?.[1] || 0);
  return ({
    1: { farm: .26, fight: .23, error: .30, obj: .14, utility: .07 },
    2: { farm: .16, fight: .30, error: .29, obj: .18, utility: .07 },
    3: { farm: .11, fight: .30, error: .25, obj: .23, utility: .11 },
    4: { farm: .06, fight: .30, error: .23, obj: .20, utility: .21 },
    5: { farm: .04, fight: .27, error: .20, obj: .17, utility: .32 }
  })[pos] || { farm: .15, fight: .27, error: .27, obj: .20, utility: .11 };
}

/* ------------------- качество данных: разобран ли матч -------------------- */
function isParsed(m) {
  if (!m || !Array.isArray(m.players) || !m.players.length) return false;
  const p0 = m.players[0] || {};
  const timeline = Array.isArray(p0.gold_t) && p0.gold_t.length > 2;
  const goldAdv = Array.isArray(m.radiant_gold_adv) && m.radiant_gold_adv.length > 2;
  const fights = Array.isArray(m.teamfights) && m.teamfights.length > 0;
  return (Number(m.duration) || 0) > 0 && (timeline || goldAdv || fights || Number(m.version) > 0);
}
function dataAvailability(m) {
  const players = Array.isArray(m && m.players) ? m.players : [];
  const p0 = players[0] || {};
  const hasStats = players.length >= 2 && players.some(p => (p.gold_per_min || 0) > 0 || (p.kills || 0) > 0 || (p.net_worth || 0) > 0);
  return {
    players: players.length === 10,
    winner: typeof (m && m.radiant_win) === "boolean",
    duration: (Number(m && m.duration) || 0) > 0,
    stats: hasStats,
    parsed: isParsed(m),
    lane: players.some(p => Number(p.lane_role) > 0),
    fights: Array.isArray(m && m.teamfights) && m.teamfights.length > 0,
    fightCount: Array.isArray(m && m.teamfights) ? m.teamfights.length : 0,
    objectives: Array.isArray(m && m.objectives) && m.objectives.length > 0,
    objectiveCount: Array.isArray(m && m.objectives) ? m.objectives.length : 0,
    timeline: Array.isArray(p0.gold_t) && p0.gold_t.length > 2,
    goldAdv: Array.isArray(m && m.radiant_gold_adv) && m.radiant_gold_adv.length > 2
  };
}
/* Надёжность вывода строится на том, какие данные реально есть,
   а не на фиксированной базе, как раньше. */
function availabilityScore(avail, roleConfidence) {
  let score = avail.parsed ? 58 : 30;
  if (avail.winner) score += 6;
  if (avail.duration) score += 4;
  if (avail.lane) score += 12;
  if (avail.fights) score += 8;
  if (avail.objectives) score += 6;
  if (avail.timeline || avail.goldAdv) score += 6;
  score += clamp(Number(roleConfidence) || 0, 0, 100) * 0.10;
  return Math.round(clamp(score, 20, 95));
}
function reliabilityLabel(score) {
  if (score >= 78) return "высокая";
  if (score >= 62) return "средняя";
  if (score >= 45) return "низкая";
  return "очень низкая";
}
function missingDataList(avail) {
  const miss = [];
  if (!avail.parsed) miss.push("матч не разобран OpenDota");
  if (!avail.lane) miss.push("нет данных по линиям (роли определены приблизительно)");
  if (!avail.fights) miss.push("нет разбора командных драк");
  if (!avail.objectives) miss.push("нет таймлайна объектов");
  if (!avail.timeline && !avail.goldAdv) miss.push("нет поминутного графика золота");
  return miss;
}

/* ------------------------------- оценка игрока ---------------------------- */
function scorePlayer(p, c) {
  const deaths = p.deaths || 0, kills = p.kills || 0, assists = p.assists || 0;
  const kp = c.teamKills ? 100 * (kills + assists) / c.teamKills : 0;
  const dmgShare = 100 * (p.hero_damage || 0) / (c.teamDamage || 1);
  const farm = p.gold_per_min || 0, duration = c.duration || 1;
  const role = p.roleInfo?.role || "Unknown", w = roleWeights(role);
  const fights = (c.m.teamfights || []).filter(f => f.players && f.players[p.player_slot]);
  let lowFightEvents = 0;
  for (const f of fights) {
    const x = f.players[p.player_slot];
    if (x.deaths > 0 && x.damage < 500) lowFightEvents++;
  }
  // Ожидания зависят от роли: поддержку не судят по фарму кора, а кору не спасает высокий KDA.
  const expectedGpm = { "Pos 1 · Carry": 520, "Pos 2 · Mid": 480, "Pos 3 · Offlane": 420, "Pos 4 · Soft Support": 330, "Pos 5 · Hard Support": 270 }[role] || 400;
  const expectedDamage = { "Pos 1 · Carry": .23, "Pos 2 · Mid": .22, "Pos 3 · Offlane": .18, "Pos 4 · Soft Support": .11, "Pos 5 · Hard Support": .09 }[role] || .17;
  const expectedKP = { "Pos 1 · Carry": 58, "Pos 2 · Mid": 62, "Pos 3 · Offlane": 62, "Pos 4 · Soft Support": 66, "Pos 5 · Hard Support": 68 }[role] || 60;
  const farmGap = clamp((expectedGpm - farm) / 8, 0, 18);
  const damageGap = clamp((expectedDamage * 100 - dmgShare) * .65, 0, 15);
  const kpGap = clamp((expectedKP - kp) * .20, 0, 12);
  const fightPenalty = damageGap + kpGap + Math.min(6, lowFightEvents * 1.5);
  const lateFactor = duration > 45 * 60 ? 1.8 : duration > 35 * 60 ? 1.45 : duration > 25 * 60 ? 1.15 : .85;
  let errorPenalty = Math.min(24, deaths * 1.9 * lateFactor);
  if (duration > 35 * 60 && deaths >= 2 && !(p.buyback_log || []).length) errorPenalty += 3;
  const objectiveTarget = { "Pos 1 · Carry": 1100, "Pos 2 · Mid": 900, "Pos 3 · Offlane": 1200, "Pos 4 · Soft Support": 700, "Pos 5 · Hard Support": 500 }[role] || 900;
  const objectivePenalty = clamp((objectiveTarget - (p.tower_damage || 0)) / 110, 0, 11);
  const utility = ((p.hero_healing || 0) / 500) + (p.obs_placed || 0) * 1.5 + (p.sentry_placed || 0) * .8;
  const utilityCredit = clamp(utility, 0, 10);
  // Ресурсы, не превращённые в результат: высокий фарм при слабом уроне и слабом давлении.
  const resourceWaste = (farm > expectedGpm + 80 && dmgShare < expectedDamage * 100 * .72 && (p.tower_damage || 0) < objectiveTarget * .7) ? 7 : 0;
  const raw = 100 * (w.farm * (farmGap / 18) + w.fight * (fightPenalty / 33) + w.error * (errorPenalty / 27) + w.obj * (objectivePenalty / 11) + w.utility * Math.max(0, (6 - utilityCredit) / 6));
  const score = clamp(raw + resourceWaste, 0, 100);

  const reasons = [];
  if (farmGap > 5) reasons.push([`Фарм ниже ожидания для ${role}`, `GPM ${fmt(farm)}; ориентир модели ≈ ${expectedGpm}.`]);
  if (damageGap > 5) reasons.push([`Низкий вклад в драках для ${role}`, `${fmt(p.hero_damage)} hero damage — ${dmgShare.toFixed(1)}% командного урона.`]);
  if (kpGap > 5) reasons.push([`Низкое участие в убийствах`, `Kill Participation ${kp.toFixed(0)}%; ориентир модели ≈ ${expectedKP}%.`]);
  if (errorPenalty > 7) reasons.push([`Цена смертей слишком высока`, `${deaths} ${plural(deaths, "смерть", "смерти", "смертей")} с повышенным весом поздней игры.`]);
  if (resourceWaste) reasons.push([`Ресурсы не конвертированы в результат`, `Высокий GPM сочетался с низким уроном и слабым давлением на строения.`]);
  if (objectivePenalty > 5) reasons.push([`Слабое давление на объекты`, `${fmt(p.tower_damage)} урона по строениям для ${role}.`]);
  if (utilityCredit > 4) reasons.push([`Положительный вклад поддержки`, `Вклад в вижен и лечение снижает итоговый blame.`]);
  if (!reasons.length) reasons.push([`Нет одного доминирующего провала`, `Оценка собрана из нескольких сигналов с учётом предполагаемой роли.`]);

  return {
    ...p, score: Math.round(score), reasons, kp, dmgShare, role,
    roleConfidence: p.roleInfo?.confidence || 0
  };
}

/* ------------------------------ загрузка матча ---------------------------- */
/* force = true просит и мост, и браузер не отдавать кеш (кнопка «Обновить»). */
async function fetchMatch(id, signal, force = false) {
  const path = `matches/${id}${force ? "?force=1" : ""}`;
  return apiFetch(path, { timeout: T.match, retries: 1, signal, fresh: true });
}

/* Запрос парсинга матча у OpenDota + ожидание результата. */
async function requestParse(id, signal, onWait) {
  await apiFetch(`request/${id}`, { method: "POST", timeout: T.request, retries: 0, signal });
  for (let i = 1; i <= PARSE_POLL.attempts; i++) {
    await sleep(PARSE_POLL.interval, signal);
    onWait && onWait(i, PARSE_POLL.attempts);
    try {
      // force: иначе опрос будет вечно получать закешированный «неразобранный» матч
      const m = await fetchMatch(id, signal, true);
      if (isParsed(m)) return m;
    } catch (e) {
      if (e.message === "Отменено") throw e;
      // отдельная неудачная попытка опроса не должна ломать ожидание
    }
  }
  return null;
}

/* Сравнение игрока с визави по той же позиции (Pos 1 vs Pos 1 и т.д.). */
function vsOpponent(p, winByPos, winRoleMap) {
  const pos = p.roleInfo && p.roleInfo.position;
  const opp = pos ? winByPos[pos] : null;
  if (!opp) return null;
  return {
    pos, opp,
    oppRole: winRoleMap[opp.player_slot] || { role: `Pos ${pos}` },
    gpm: p.gold_per_min || 0, ogpm: opp.gold_per_min || 0,
    nw: p.net_worth || 0, onw: opp.net_worth || 0,
    lh: p.last_hits || 0, olh: opp.last_hits || 0,
    xpm: p.xp_per_min || 0, oxpm: opp.xp_per_min || 0,
    dmg: p.hero_damage || 0, odmg: opp.hero_damage || 0
  };
}
function vsRow(label, mine, theirs) {
  const diff = mine - theirs;
  const cls = diff < 0 ? "neg" : "pos";
  return `<div class="vsRow"><span>${esc(label)}</span><b>${fmt(mine)}</b><i>→</i><b>${fmt(theirs)}</b><small class="${cls}">${diff >= 0 ? "+" : "−"}${fmt(Math.abs(diff))}</small></div>`;
}
function vsBlock(vs) {
  if (!vs) return "";
  return `<div class="vsBox"><div class="vsBoxTitle">Против визави · ${esc(vs.oppRole.role)}${vs.opp.personaname ? " · " + esc(vs.opp.personaname) : ""}</div>${vsRow("GPM", vs.gpm, vs.ogpm)}${vsRow("Net Worth", vs.nw, vs.onw)}${vsRow("Last Hits", vs.lh, vs.olh)}${vsRow("XPM", vs.xpm, vs.oxpm)}${vsRow("Hero DMG", vs.dmg, vs.odmg)}</div>`;
}

/* -------------------------------- анализ --------------------------------- */
function analyze(m, avail) {
  const players = m.players.map((p, i) => ({ ...p, idx: i, team: teamOf(p) }));
  const losing = m.radiant_win ? "Dire" : "Radiant";
  const team = players.filter(p => p.team === losing);
  const win = players.filter(p => p.team !== losing);
  const teamKills = team.reduce((a, p) => a + (p.kills || 0), 0);
  const teamDamage = team.reduce((a, p) => a + (p.hero_damage || 0), 0) || 1;
  const duration = m.duration || 1;
  const roleMap = inferRoles(team);
  const winRoleMap = inferRoles(win);
  const winByPos = {};
  for (const w of win) { const pos = winRoleMap[w.player_slot].position; winByPos[pos] = w; }
  const enriched = team.map(p => ({ ...p, roleInfo: roleMap[p.player_slot] }));
  const ctx = { team: enriched, win, m, teamKills, teamDamage, duration };
  const scored = enriched.map(p => {
    const s = scorePlayer(p, ctx);
    s.confidence = availabilityScore(avail, s.roleConfidence);
    s.vs = vsOpponent(p, winByPos, winRoleMap);
    return s;
  }).sort((a, b) => b.score - a.score);
  return { all: players, losing, team, win, scored, culprit: scored[0] || null, closeRuiner: scored[1] || null, avail };
}

/* --------------------------------- рендер -------------------------------- */
const state = { matchId: null, lastMatch: null, lastResult: null };

function impactLabel(score) {
  if (score >= 75) return "Очень высокое";
  if (score >= 55) return "Высокое";
  if (score >= 35) return "Умеренное";
  if (score >= 20) return "Небольшое";
  return "Низкое";
}
function impactClass(score) {
  if (score >= 75) return "very-high";
  if (score >= 55) return "high";
  if (score >= 35) return "moderate";
  if (score >= 20) return "low";
  return "minimal";
}
function metricLine(label, value, detail) {
  return `<div class="vmetric"><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(detail)}</small></div>`;
}
function noticeHtml(kind, title, text, actionsHtml = "") {
  const icon = kind === "bad" ? "⛔" : kind === "warn" ? "⚠️" : "ℹ️";
  return `<div class="noticeBox ${kind}"><div class="noticeHead">${icon} <b>${esc(title)}</b></div><p>${esc(text)}</p>${actionsHtml ? `<div class="noticeActions">${actionsHtml}</div>` : ""}</div>`;
}
function qualityChips(avail) {
  const chip = (ok, label) => `<span class="chip ${ok ? "ok" : "no"}">${ok ? "✓" : "✕"} ${esc(label)}</span>`;
  return `<div class="chips">${chip(avail.parsed, "разбор OpenDota")}${chip(avail.lane, "линии")}${chip(avail.fights, `драки${avail.fightCount ? ": " + avail.fightCount : ""}`)}${chip(avail.objectives, `объекты${avail.objectiveCount ? ": " + avail.objectiveCount : ""}`)}${chip(avail.timeline || avail.goldAdv, "таймлайн золота")}${chip(avail.winner, "победитель")}</div>`;
}

function overview(m, all, avail) {
  const net = all.filter(p => p.team === "Radiant").reduce((a, p) => a + (p.net_worth || 0), 0)
    - all.filter(p => p.team === "Dire").reduce((a, p) => a + (p.net_worth || 0), 0);
  const row = (label, value) => `<div><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
  return `<div class="ov">
    ${row("Длительность", avail.duration ? time(m.duration) : "нет данных")}
    ${row("Победитель", avail.winner ? (m.radiant_win ? "Radiant" : "Dire") : "неизвестен")}
    ${row("Счёт", avail.winner ? `${fmt(m.radiant_score)} : ${fmt(m.dire_score)}` : "—")}
    ${row("Net Worth diff", `${net >= 0 ? "+" : ""}${fmt(net)}`)}
    ${row("Teamfights", avail.fights ? fmt(avail.fightCount) : "нет данных")}
    ${row("Objectives", avail.objectives ? fmt(avail.objectiveCount) : "нет данных")}
    ${row("Roshan", avail.objectives ? fmt((m.objectives || []).filter(o => String(o.type).toLowerCase().includes("roshan")).length) : "—")}
    ${row("Разбор OpenDota", avail.parsed ? "есть" : "нет")}
  </div>${qualityChips(avail)}`;
}

function verdictText(m, p, r, avail) {
  const gap = r ? Math.max(0, p.score - r.score) : 0;
  const lead = r && gap >= 8
    ? `Он заметно оторвался от следующего игрока по модели: ${gap} ${plural(gap, "балл", "балла", "баллов")}.`
    : r ? `Разрыв с ближайшим по оценке игроком небольшой — всего ${gap} ${plural(gap, "балл", "балла", "баллов")}, поэтому матч нельзя сводить к одной цифре.`
      : `Для сравнения доступен только основной результат модели.`;
  const deaths = p.deaths || 0;
  const deathText = deaths >= 4
    ? `${deaths} ${plural(deaths, "смерть", "смерти", "смертей")} — заметный источник потерь темпа${avail.duration ? `, особенно с учётом длительности ${time(m.duration)}` : ""}.`
    : deaths >= 2
      ? `${deaths} ${plural(deaths, "смерть", "смерти", "смертей")} добавили команде цену ошибок, но сами по себе не являются главным доказательством.`
      : `Смертей немного (${deaths}), поэтому итог не строится только на KDA.`;
  const farmText = `${fmt(p.gold_per_min)} GPM, ${fmt(p.net_worth)} net worth и ${fmt(p.last_hits)} last hits`;
  const fightText = `${p.kp.toFixed(0)}% KP и ${p.dmgShare.toFixed(1)}% командного hero damage`;
  const objText = `${fmt(p.tower_damage)} урона по строениям`;
  const reasons = p.reasons.slice(0, 3).map(x => `<li><b>${esc(x[0])}</b><span>${esc(x[1])}</span></li>`).join("");
  const caveat = avail.parsed
    ? ""
    : `<p class="verdictCaveat">Матч не разобран OpenDota, поэтому роли и часть сигналов определены приблизительно — вывод опирается на итоговую статистику.</p>`;
  return `<div class="verdictCopy"><p><strong>${esc(p.personaname || "Этот игрок")}</strong> сыграл наиболее негативную роль в поражении. Модель сравнивает его показатели с ожидаемыми для <strong>его роли в игре</strong>, а затем проверяет, подтверждается ли провал несколькими независимыми сигналами.</p><p>${esc(lead)} Здесь важен контекст: ${esc(deathText)}</p>${caveat}<div class="vmetrics">${metricLine("Экономика", farmText, "ожидания роли учитываются отдельно")}${metricLine("Влияние в драках", fightText, "урон и участие в убийствах")}${metricLine("Объекты", objText, "давление на карту и строения")}${metricLine("Влияние на поражение", impactLabel(p.score), `надёжность вывода: ${reliabilityLabel(p.confidence)} (${p.confidence}%)`)}</div>${vsBlock(p.vs)}<div class="verdictReasons"><h3>Что сильнее всего повлияло</h3><ul>${reasons || '<li><b>Сигналы распределены равномерно</b><span>Нет одного показателя, который объясняет поражение целиком.</span></li>'}</ul></div></div>`;
}
function nearRuinerHtml(p) {
  const rs = p.reasons.slice(0, 3).map(x => `<li><b>${esc(x[0])}</b><span>${esc(x[1])}</span></li>`).join("");
  return `<div class="nearHead"><img src="${heroImg(p)}" alt="" onerror="this.style.visibility='hidden'"><div><div class="nearLabel">БЛИЗКИЙ К РУИНУ ИГРОК</div><h3>${esc(p.personaname || "Unknown")}</h3><p>${esc(heroName(p))} · ${esc(p.role)}</p></div><strong>${p.score}</strong></div><div class="nearStats"><span>K/D/A <b>${p.kills || 0}/${p.deaths || 0}/${p.assists || 0}</b></span><span>GPM <b>${fmt(p.gold_per_min)}</b></span><span>KP <b>${p.kp.toFixed(0)}%</b></span><span>Hero DMG <b>${fmt(p.hero_damage)}</b></span></div><ul class="nearReasons">${rs}</ul>`;
}
function winnerPlayerCard(p) {
  const role = p.roleInfo?.role || "—";
  return `<div class="winnerPlayer"><img class="heroIcon" src="${heroImg(p)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"><div class="winnerPlayerMain"><b>${esc(p.personaname || `Игрок ${p.idx + 1}`)}</b><span>${esc(heroName(p))} · ${esc(role)}</span><small>K/D/A ${p.kills || 0}/${p.deaths || 0}/${p.assists || 0} · GPM ${fmt(p.gold_per_min)} · XPM ${fmt(p.xp_per_min)} · Урон ${fmt(p.hero_damage)}</small></div><strong>${fmt(p.net_worth)} NW</strong></div>`;
}
function playerCard(p, isCulprit) {
  const items = itemsOf(p);
  return `<div class="playerCard ${isCulprit ? "culprit" : ""}">
  <div class="playerHead"><img class="heroIcon" src="${heroImg(p)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"><div><div class="pname">${esc(p.personaname || "Unknown")}</div><div class="heroName">${esc(heroName(p))} · <b>${esc(p.role || "Unknown")}</b> <small>(${p.roleConfidence}%)</small></div></div><div class="pScore">${p.score}</div></div>
  <div class="statgrid"><span>K/D/A <b>${p.kills || 0}/${p.deaths || 0}/${p.assists || 0}</b></span><span>GPM <b>${fmt(p.gold_per_min)}</b></span><span>XPM <b>${fmt(p.xp_per_min)}</b></span><span>Last Hits <b>${fmt(p.last_hits)}</b></span><span>Hero DMG <b>${fmt(p.hero_damage)}</b></span><span>DMG Share <b>${p.dmgShare.toFixed(1)}%</b></span><span>KP <b>${p.kp.toFixed(0)}%</b></span><span>Tower DMG <b>${fmt(p.tower_damage)}</b></span><span>Net Worth <b>${fmt(p.net_worth)}</b></span><span>Healing <b>${fmt(p.hero_healing)}</b></span><span>Wards <b>${fmt((p.obs_placed || 0) + (p.sentry_placed || 0))}</b></span><span>Denies <b>${fmt(p.denies)}</b></span></div>
  <div class="build"><span>Сборка</span>${items.length ? items.map(itemHtml).join("") : "<em>нет данных</em>"}${Object.keys(ITEMS).length === 0 && items.length ? '<small class="buildHint">справочник предметов не загрузился</small>' : ""}</div>
  ${p.vs ? `<div class="vsLine">визави ${esc(p.vs.oppRole.role)}: GPM ${fmt(p.vs.gpm)} → ${fmt(p.vs.ogpm)} · NW ${fmt(p.vs.nw)} → ${fmt(p.vs.onw)}</div>` : ""}
 </div>`;
}

/* ------------------------- эпизоды по разобранным данным ------------------- */
function buildEvents(m, p) {
  const out = [], slot = p.player_slot;
  const eventPlayer = { name: p.personaname || "Игрок", hero: heroName(p), img: heroImg(p) };

  for (const f of (m.teamfights || [])) {
    const x = f.players && f.players[slot];
    if (!x) continue;
    const dmg = x.damage || 0, k = x.kills || 0, a = x.assists || 0, d = x.deaths || 0;
    if (d > 0) {
      out.push({ t: time(f.start || 0), tSec: Number(f.start || 0), player: eventPlayer, title: "Смерть в командной драке", text: `${fmt(dmg)} hero damage • ${k} ${plural(k, "убийство", "убийства", "убийств")} • ${a} ${plural(a, "ассист", "ассиста", "ассистов")} • ${d} ${plural(d, "смерть", "смерти", "смертей")}`, danger: dmg < 500, why: dmg < 500 ? "Смерть произошла при небольшом личном вкладе в драку." : "Смерть есть, но у игрока был заметный вклад уроном — поэтому эпизод не считается автоматической ошибкой." });
    } else if (dmg > 1000 || k + a >= 2) {
      out.push({ t: time(f.start || 0), tSec: Number(f.start || 0), player: eventPlayer, title: "Заметный вклад в teamfight", text: `${fmt(dmg)} hero damage • ${k} ${plural(k, "убийство", "убийства", "убийств")} • ${a} ${plural(a, "ассист", "ассиста", "ассистов")}`, danger: false, why: "Игрок конвертировал присутствие в драке в урон или убийства — это положительный сигнал." });
    }
  }

  for (const o of (m.objectives || [])) {
    if (o.player_slot !== slot || !o.type) continue;
    out.push({ t: time(o.time || 0), tSec: Number(o.time || 0), player: eventPlayer, title: `Объект: ${String(o.type)}`, text: o.subtype || "Событие найдено в данных матча.", danger: false, why: "Участие в объективе учитывается как вклад в продвижение команды." });
  }

  const real = out.sort((a, b) => a.tSec - b.tSec).slice(0, 10);
  if (real.length) return real;

  // OpenDota не всегда отдаёт teamfights/objectives: показываем derived-сигналы
  // из итоговой статистики, не придумывая конкретное время.
  const deaths = p.deaths || 0, kp = p.kp || 0, dmgShare = p.dmgShare || 0, tower = p.tower_damage || 0, gpm = p.gold_per_min || 0;
  const derived = [];
  if (deaths >= 3) derived.push({ t: "По итогам матча", player: eventPlayer, title: "Высокая цена смертей", text: `${deaths} ${plural(deaths, "смерть", "смерти", "смертей")} за матч`, danger: true, why: "Без таймлайна нельзя утверждать, какая именно смерть стала переломной, но количество смертей заметно увеличивает цену ошибок." });
  if (kp < 45) derived.push({ t: "По итогам матча", player: eventPlayer, title: "Низкое участие в убийствах", text: `Kill Participation ${kp.toFixed(0)}%`, danger: true, why: "Игрок редко участвовал в результативных действиях команды; для оценки важно учитывать его роль и ожидания от неё." });
  else if (kp >= 65) derived.push({ t: "По итогам матча", player: eventPlayer, title: "Активное участие в убийствах", text: `Kill Participation ${kp.toFixed(0)}%`, danger: false, why: "Высокое участие в убийствах снижает вероятность того, что игрок полностью выпал из командной игры." });
  if (dmgShare < 10) derived.push({ t: "По итогам матча", player: eventPlayer, title: "Небольшой вклад в hero damage", text: `${dmgShare.toFixed(1)}% командного hero damage`, danger: true, why: "Доля урона низкая. Это не самостоятельное доказательство ошибки — показатель оценивается вместе с ролью, фармом и участием в игре." });
  else if (dmgShare >= 20) derived.push({ t: "По итогам матча", player: eventPlayer, title: "Высокий вклад в hero damage", text: `${dmgShare.toFixed(1)}% командного hero damage`, danger: false, why: "Игрок внёс заметную долю командного урона, поэтому его нельзя оценивать только по KDA или смертям." });
  if (tower < 500) derived.push({ t: "По итогам матча", player: eventPlayer, title: "Ограниченное давление на объекты", text: `${fmt(tower)} урона по строениям`, danger: true, why: "Урон по строениям небольшой. Значимость этого сигнала зависит от роли и от того, насколько команда вообще имела окна для пуша." });
  if (gpm > 0 && derived.length < 2) derived.push({ t: "По итогам матча", player: eventPlayer, title: "Экономика матча", text: `${fmt(gpm)} GPM • ${fmt(p.net_worth)} net worth • ${fmt(p.last_hits)} last hits`, danger: false, why: "Экономика используется как контекст: высокий или низкий фарм сам по себе не доказывает руин." });
  if (!derived.length) derived.push({ t: "По итогам матча", player: eventPlayer, title: "Недостаточно событий для точной привязки", text: "OpenDota не передал подробный teamfight/objective timeline", danger: false, why: "Сервис показывает только проверяемые сигналы из статистики и не придумывает конкретные минуты или события." });
  return derived.slice(0, 5);
}

/* -------------------- история игры: только реальные данные ---------------- */
/* Раньше фазы считались по итоговым net worth и kills, то есть во всех фазах
   были одни и те же числа. Теперь фазы строятся по таймлайнам:
   radiant_gold_adv / gold_t, kills_log, objectives и teamfights. */
function phasesFor(duration) {
  const d = Math.max(1, Number(duration) || 0);
  if (d <= 20 * 60) return [{ name: "Ранняя игра", start: 0, end: d }];
  if (d <= 32 * 60) return [{ name: "Лайнинг", start: 0, end: 12 * 60 }, { name: "Мидгейм и концовка", start: 12 * 60, end: d }];
  const mid = 25 * 60;
  return [{ name: "Лайнинг", start: 0, end: 12 * 60 }, { name: "Мидгейм", start: 12 * 60, end: mid }, { name: "Лейт", start: mid, end: d }];
}
function teamGoldSeries(m, teamName) {
  const players = (m.players || []).filter(p => teamOf(p) === teamName);
  let len = 0;
  for (const p of players) if (Array.isArray(p.gold_t)) len = Math.max(len, p.gold_t.length);
  if (!len) return null;
  const out = new Array(len).fill(0);
  for (const p of players) {
    const g = p.gold_t || [];
    for (let i = 0; i < len; i++) out[i] += Number(g[Math.min(i, Math.max(0, g.length - 1))]) || 0;
  }
  return out;
}
/* Преимущество проигравшей команды по золоту на минуте minute.
   Возвращает null, если таймлайна нет. */
function goldGapAt(m, loseTeam, winTeam, minute) {
  const idx = Math.max(0, Math.round(Number(minute) || 0) - 1);
  const adv = m.radiant_gold_adv;
  if (Array.isArray(adv) && adv.length > 1) {
    const v = Number(adv[Math.max(0, Math.min(adv.length - 1, idx))]) || 0;
    return loseTeam === "Radiant" ? v : -v;
  }
  const l = teamGoldSeries(m, loseTeam), w = teamGoldSeries(m, winTeam);
  if (!l || !w) return null;
  return (l[Math.max(0, Math.min(l.length - 1, idx))] || 0) - (w[Math.max(0, Math.min(w.length - 1, idx))] || 0);
}
function teamKillsIn(m, teamName, t0, t1) {
  let n = 0;
  for (const p of (m.players || [])) {
    if (teamOf(p) !== teamName) continue;
    for (const k of (p.kills_log || [])) {
      const t = Number(k && k.time);
      if (Number.isFinite(t) && t >= t0 && t < t1) n++;
    }
  }
  return n;
}
const OBJECTIVE_KEYS = /(TOWER_KILL|BARRACKS_KILL|ROSHAN_KILL|AEGIS|building_kill)/i;
function teamObjectivesIn(m, teamName, t0, t1) {
  const teamCode = teamName === "Radiant" ? 2 : 3;
  let n = 0;
  for (const o of (m.objectives || [])) {
    const t = Number(o && o.time);
    if (!Number.isFinite(t) || t < t0 || t >= t1) continue;
    if (!OBJECTIVE_KEYS.test(String(o.type || ""))) continue;
    if (Number(o.team) === teamCode) n++;
  }
  return n;
}
function fightsIn(m, t0, t1) {
  return (m.teamfights || []).filter(f => { const t = Number(f.start || 0); return t >= t0 && t < t1; });
}
function findTurningPoint(m, all, p, loseTeam, winTeam) {
  const fights = (m.teamfights || []).map(f => {
    const sideScore = teamName => all.filter(x => x.team === teamName).reduce((a, x) => {
      const z = f.players && f.players[x.player_slot];
      return a + (z ? (z.kills || 0) * 120 + (z.assists || 0) * 45 - (z.deaths || 0) * 150 + (z.damage || 0) * .08 : 0);
    }, 0);
    return { f, swingScore: sideScore(winTeam) - sideScore(loseTeam), cp: f.players && f.players[p.player_slot] };
  }).sort((a, b) => b.swingScore - a.swingScore);

  const best = fights.find(x => x.cp && (x.cp.deaths || 0) > 0) || fights[0];
  if (best) {
    const x = best.cp || {}, tSec = Number(best.f.start || 0);
    const gapBefore = goldGapAt(m, loseTeam, winTeam, tSec / 60 - 1);
    const gapAfter = goldGapAt(m, loseTeam, winTeam, tSec / 60 + 3);
    const swing = (gapBefore !== null && gapAfter !== null) ? gapAfter - gapBefore : null;
    const whyParts = [];
    if ((x.deaths || 0) > 0) whyParts.push("после этой драки соперник получил наиболее заметный перевес по её результату");
    else whyParts.push("это одна из самых тяжёлых драк по итоговому размену");
    if (swing !== null && swing < -400) whyParts.push(`золотое преимущество соперника выросло примерно на ${fmt(Math.abs(swing))}`);
    return {
      t: time(tSec),
      title: (x.deaths || 0) > 0 ? `${p.personaname || "Игрок"} погиб в важной драке` : "Команда потеряла преимущество в драке",
      text: `${fmt(x.damage || 0)} hero damage, ${x.kills || 0} ${plural(x.kills || 0, "убийство", "убийства", "убийств")}, ${x.assists || 0} ${plural(x.assists || 0, "ассист", "ассиста", "ассистов")} и ${x.deaths || 0} ${plural(x.deaths || 0, "смерть", "смерти", "смертей")}.`,
      why: whyParts.join(", ") + "."
    };
  }
  return {
    t: "—",
    title: p.deaths >= 2 ? `${p.personaname || "Игрок"} потерял темп из-за смертей в поздней игре` : "Преимущество постепенно перешло к сопернику",
    text: "В данных OpenDota нет достаточного количества событий, чтобы привязать перелом к одному моменту.",
    why: "Поэтому сервис не придумывает конкретную причину."
  };
}
function lessonAction(p) {
  const role = p.role || "";
  if (/Pos 1/.test(role)) return "После ключевого предмета искать окно для драки или объекта, а не продолжать фарм автоматически.";
  if (/Pos 2/.test(role)) return "После получения преимущества превращать его в драки и объекты, а не только в дополнительный фарм.";
  if (/Pos 3/.test(role)) return "Инициировать игру вокруг команды и объектов, а не отдавать темп пассивным фармом.";
  return "Искать активное влияние на карту: драки, объекты, вижен и помощь корам в правильный момент.";
}
function mainLesson(p) {
  const r = p.reasons[0];
  if (r) return { title: r[0], text: r[1], action: lessonAction(p) };
  return { title: "Не один показатель решал исход", text: "Вклад игрока сформирован несколькими сигналами, поэтому исправлять нужно не одну цифру.", action: "Смотри на связку фарм → драка → объект, а не только на KDA." };
}
function notTheirFault(p) {
  const deaths = p.deaths || 0, dmg = p.dmgShare || 0, kp = p.kp || 0;
  if (kp >= 55 && dmg >= 12) return { title: "Ты реально участвовал в драках", text: `${kp.toFixed(0)}% KP и ${dmg.toFixed(1)}% командного hero damage показывают, что низкий KDA сам по себе не описывает твою игру.` };
  if (deaths <= 2) return { title: "Смерти не были главным источником проблем", text: `У тебя ${deaths} ${plural(deaths, "смерть", "смерти", "смертей")}. Итоговый вывод не строится только на их количестве.` };
  return { title: "Поражение было командным", text: "Даже при высоком негативном score одного игрока нельзя считать единственной причиной поражения: оценка учитывает его вклад относительно роли и контекста матча." };
}

function matchStory(m, all, culprit, avail) {
  if (!avail.parsed && !avail.fights && !avail.objectives) {
    return `<div class="empty">OpenDota не разобрал этот матч, поэтому истории игры по фазам нет: построить её можно только по поминутным данным, а их в ответе нет.</div>`;
  }
  const dur = Number(m.duration) || 0;
  const winTeam = m.radiant_win ? "Radiant" : "Dire";
  const loseTeam = winTeam === "Radiant" ? "Dire" : "Radiant";
  const hasGold = Array.isArray(m.radiant_gold_adv) && m.radiant_gold_adv.length > 1 || !!teamGoldSeries(m, loseTeam);

  const rows = phasesFor(dur).map(ph => {
    const goldGap = hasGold ? goldGapAt(m, loseTeam, winTeam, ph.end / 60) : null;
    const killsLose = teamKillsIn(m, loseTeam, ph.start, ph.end);
    const killsWin = teamKillsIn(m, winTeam, ph.start, ph.end);
    const objLose = teamObjectivesIn(m, loseTeam, ph.start, ph.end);
    const objWin = teamObjectivesIn(m, winTeam, ph.start, ph.end);
    const fights = fightsIn(m, ph.start, ph.end);
    const hasKills = killsLose + killsWin > 0;

    const parts = [];
    if (goldGap !== null) parts.push(`золото ${goldGap >= 0 ? "+" : "−"}${fmt(Math.abs(goldGap))}`);
    if (hasKills) parts.push(`убийства ${killsLose}:${killsWin}`);
    if (objWin || objLose) parts.push(`объекты: свои ${objLose}, у врага ${objWin}`);
    if (fights.length) parts.push(`драк ${fights.length}`);

    let tone = "neutral";
    let text = "По доступным данным команды шли примерно на равных.";
    if ((goldGap !== null && goldGap <= -1500) || (hasKills && killsLose - killsWin <= -2) || objWin > objLose) {
      tone = "bad";
      const bad = [];
      if (goldGap !== null && goldGap < 0) bad.push(`перевес ${fmt(Math.abs(goldGap))} золота`);
      if (objWin) bad.push(`${objWin} ${plural(objWin, "объектив", "объектива", "объективов")}`);
      if (hasKills && killsLose < killsWin) bad.push(`размен по убийствам ${killsLose}:${killsWin}`);
      text = `Итог фазы в пользу соперника: ${bad.join(", ") || "потеря темпа"}.`;
    } else if ((goldGap !== null && goldGap >= 1500) || (hasKills && killsLose - killsWin >= 2) || objLose > objWin) {
      tone = "good";
      const good = [];
      if (goldGap !== null && goldGap > 0) good.push(`перевес ${fmt(goldGap)} золота`);
      if (objLose) good.push(`${objLose} ${plural(objLose, "объектив", "объектива", "объективов")}`);
      if (hasKills && killsLose > killsWin) good.push(`размен по убийствам ${killsLose}:${killsWin}`);
      text = `Итог фазы в пользу вашей команды: ${good.join(", ") || "лучший размен"}.`;
    } else if (goldGap !== null && goldGap <= -700) {
      text = `Соперник был немного впереди по золоту (${fmt(Math.abs(goldGap))}), но решающего перевеса в этой фазе не было.`;
    } else if (goldGap !== null && goldGap >= 700) {
      text = `Небольшой перевес по золоту был у проигравшей команды (${fmt(goldGap)}), но развить его не удалось.`;
    }
    return `<div class="phase ${tone}"><div class="phaseHead"><b>${esc(ph.name)}</b><span>${time(ph.start)}–${time(ph.end)}</span></div><p>${esc(text)}</p><small>${esc(parts.join(" · ") || "подробных данных по фазе нет")}</small></div>`;
  }).join("");

  const turning = findTurningPoint(m, all, culprit, loseTeam, winTeam);
  const lesson = mainLesson(culprit);
  const innocence = notTheirFault(culprit);
  const note = avail.parsed ? "" : `<div class="storyNote">Часть данных OpenDota для этого матча недоступна, поэтому фазы показаны только по тому, что есть.</div>`;

  return `${note}<div class="storyGrid"><div class="phases">${rows}</div><div class="turning"><div class="storyLabel">⚡ МОМЕНТ ПЕРЕЛОМА</div><h3>${esc(turning.title)}</h3><div class="turnTime">${esc(turning.t)}</div><p>${esc(turning.text)}</p><b>${esc(turning.why)}</b></div><div class="lesson"><div class="storyLabel">🎯 ГЛАВНЫЙ УРОК</div><h3>${esc(lesson.title)}</h3><p>${esc(lesson.text)}</p><div class="nextGame"><span>В следующей игре</span><b>${esc(lesson.action)}</b></div></div><div class="innocence"><div class="storyLabel goodLabel">🟢 ЧТО НЕ БЫЛО ТВОЕЙ ОШИБКОЙ</div><h3>${esc(innocence.title)}</h3><p>${esc(innocence.text)}</p></div></div>`;
}

/* ------------------------------- отрисовка -------------------------------- */
function render(m, res) {
  const { all, scored, culprit, closeRuiner, avail } = res;
  $("result").classList.remove("hidden");
  $("culpritHero").src = heroImg(culprit);
  $("culpritRank").src = rankImg(culprit.rank_tier);
  $("culpritRankText").textContent = rankName(culprit.rank_tier);
  $("culpritName").textContent = culprit.personaname || `Игрок ${culprit.idx + 1}`;
  $("culpritScore").textContent = impactLabel(culprit.score);
  $("culpritScore").className = `impactValue ${impactClass(culprit.score)}`;
  $("confidence").textContent = `Надёжность вывода: ${reliabilityLabel(culprit.confidence)} · ${culprit.confidence}%`;
  $("confidence").className = `confidence q-${impactClass(100 - culprit.confidence)}`;
  $("summary").innerHTML = verdictText(m, culprit, closeRuiner, avail);
  $("nearRuiner").innerHTML = closeRuiner ? nearRuinerHtml(closeRuiner) : '<div class="nearEmpty">Второй игрок не набрал достаточно сигналов для отдельного сравнения.</div>';
  $("matchOverview").innerHTML = overview(m, all, avail);

  const winningTeam = m.radiant_win ? "Radiant" : "Dire";
  const winPlayers = all.filter(p => p.team === winningTeam);
  const winRoles = inferRoles(winPlayers);
  const winningPlayers = winPlayers.map(p => ({ ...p, roleInfo: winRoles[p.player_slot] }));
  $("winnerTeamName").textContent = `${winningTeam} · ${fmt(m.radiant_win ? m.radiant_score : m.dire_score)} : ${fmt(m.radiant_win ? m.dire_score : m.radiant_score)}`;
  $("winnerTeam").innerHTML = winningPlayers.map(p => winnerPlayerCard(p)).join("");
  $("players").innerHTML = scored.map(p => playerCard(p, p === culprit)).join("");

  const events = buildEvents(m, culprit);
  $("events").innerHTML = events.length
    ? events.map(e => `<div class="event ${e.danger ? "danger" : ""}"><div class="eventTop"><span class="eventTime">${esc(e.t)}</span><span class="eventTag ${e.danger ? "bad" : ""}">${e.danger ? "НЕГАТИВНЫЙ СИГНАЛ" : "ПОЛОЖИТЕЛЬНЫЙ СИГНАЛ"}</span></div><div class="eventPlayer"><img src="${e.player.img || ""}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"><div><strong>${esc(e.player.name)}</strong><span>${esc(e.player.hero)}</span></div></div><b>${esc(e.title)}</b><div class="eventWhat"><strong>Что произошло:</strong> ${esc(e.text)}</div><div class="eventWhy"><strong>Почему это важно:</strong> ${esc(e.why)}</div></div>`).join("")
    : `<div class="empty">Для этого матча данных о событиях недостаточно.</div>`;

  $("matchStory").innerHTML = matchStory(m, all, culprit, avail);
  $("reasons").innerHTML = culprit.reasons.map(r => `<div class="reason"><strong>+ ${esc(r[0])}</strong><span>${esc(r[1])}</span></div>`).join("");

  const openLink = $("openMatch");
  const matchId = m.match_id || state.matchId;
  if (openLink && matchId) openLink.href = `${OPENDOTA_MATCH}/${matchId}`;
}

/* ------------------------------ поток анализа ----------------------------- */
let runToken = 0, runCtrl = null;
function beginRun() { runToken++; runCtrl = new AbortController(); return { token: runToken, signal: runCtrl.signal }; }
function cancelRun() { runToken++; try { runCtrl && runCtrl.abort(); } catch (e) { } }
const isStale = r => r.token !== runToken;

let ticker = null, tickerBase = "", tickerStart = 0;
function setStatus(text) { const el = $("status"); if (el) el.textContent = text || ""; }
function paintStatus() { setStatus(`${tickerBase} (${Math.round((Date.now() - tickerStart) / 1000)} с)`); }
function startTicker(text) {
  tickerBase = text;
  tickerStart = Date.now();
  if (ticker) clearInterval(ticker);
  setStatus(text);
  ticker = setInterval(paintStatus, 1000);
}
/* Меняет текст, не сбрасывая счётчик секунд (используется при ожидании парсинга). */
function setTickerText(text) { tickerBase = text; paintStatus(); }
function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }
function setBusy(busy) {
  const btn = $("submit");
  const cancel = $("cancel");
  if (btn) { btn.disabled = busy; btn.textContent = busy ? "АНАЛИЗИРУЕМ…" : "АНАЛИЗИРОВАТЬ"; }
  if (cancel) cancel.classList.toggle("hidden", !busy);
}
function showNotice(html) {
  const el = $("notice");
  if (!el) return;
  el.innerHTML = html || "";
  el.classList.toggle("hidden", !html);
}

/* Скелетон загрузки и история последних разборов. */
function showSkeleton(on) {
  const el = $("skeleton");
  if (el) el.classList.toggle("hidden", !on);
}
function renderHistory() {
  const el = $("history");
  if (!el) return;
  const list = readHistory();
  if (!list.length) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  el.innerHTML = `<span class="historyLabel">Недавние:</span>` + list.map(h =>
    `<button type="button" class="histChip" data-id="${esc(h.id)}" title="Разобрать матч ${esc(h.id)}">#${esc(h.id)}<em>${esc(h.hero || h.culprit || "")}</em></button>`
  ).join("");
  el.classList.remove("hidden");
}

async function runAnalysis(id, opts = {}) {
  const run = beginRun();
  const { signal } = run;
  setBusy(true);
  showNotice("");
  $("result").classList.add("hidden");
  showSkeleton(true);
  try {
    // Сначала пробуем локальный кеш матча: экономит лимит OpenDota.
    let m = null, fromCache = false;
    const cached = opts.force ? null : readMatchCache(id);
    if (cached) { m = cached.m; fromCache = true; }
    else {
      startTicker("Загружаем матч из OpenDota…");
      m = await fetchMatch(id, signal, opts.force);
      if (isStale(run)) return;
      writeMatchCache(id, m);
    }
    const avail = dataAvailability(m);
    state.matchId = String(id);
    writeMatchToUrl(id);

    if (!avail.stats) {
      stopTicker(); setBusy(false); setStatus("");
      showNotice(noticeHtml("bad", "По этому матчу нет данных",
        "OpenDota вернул матч, но в нём нет статистики игроков: обычно так бывает у матчей в режиме приватной лобби, у очень старых игр или если матч ещё не проиндексирован. Проверь Match ID или открой матч на OpenDota.",
        `<a class="btnGhost" href="${OPENDOTA_MATCH}/${encodeURIComponent(id)}" target="_blank" rel="noopener">Открыть на OpenDota</a>`));
      return;
    }
    if (!avail.winner) {
      stopTicker(); setBusy(false); setStatus("");
      showNotice(noticeHtml("bad", "В матче не указан победитель",
        "Без победителя невозможно определить проигравшую команду, а значит и виновника поражения. Скорее всего матч ещё не проиндексирован полностью.",
        `<a class="btnGhost" href="${OPENDOTA_MATCH}/${encodeURIComponent(id)}" target="_blank" rel="noopener">Открыть на OpenDota</a>`));
      return;
    }

    // Профиль виновника нужен только для ранга и аватара: без него разбор работает.
    const res = analyze(m, avail);
    if (!res.culprit.rank_tier && res.culprit.account_id) {
      try {
        const prof = await apiFetch(`players/${res.culprit.account_id}`, { timeout: T.poll, retries: 0, signal });
        if (prof && prof.rank_tier) res.culprit.rank_tier = prof.rank_tier;
      } catch (e) { if (e.message === "Отменено") throw e; }
      if (isStale(run)) return;
    }

    render(m, res);
    state.lastMatch = m;
    state.lastResult = res;
    pushHistory({ id: String(id), ts: Date.now(), hero: heroName(res.culprit), culprit: res.culprit.personaname, score: res.culprit.score });
    renderHistory();

    if (fromCache) {
      const age = Math.max(0, Math.round((Date.now() - cached.ts) / 60000));
      showNotice(noticeHtml("info", "Загружено из локального кеша",
        `Разбор взят из кеша (сохранён ${age} мин назад), чтобы не расходовать лимит OpenDota. Нажми «Обновить», чтобы получить свежие данные.`,
        `<button type="button" class="btnPrimary" id="refreshBtn">Обновить</button>`));
    } else if (!avail.parsed) {
      const parseAction = opts.parseOffered === false ? "" : `<button type="button" class="btnPrimary" id="parseBtn">Запросить разбор у OpenDota</button>`;
      showNotice(noticeHtml("warn", "Матч не разобран OpenDota",
        `Разбор построен только по итоговой статистике: ${missingDataList(avail).join("; ")}. Роли и часть сигналов приблизительны, поэтому надёжность вывода снижена.`,
        `${parseAction}<a class="btnGhost" href="${OPENDOTA_MATCH}/${encodeURIComponent(id)}" target="_blank" rel="noopener">Открыть на OpenDota</a>`));
    } else {
      const miss = missingDataList(avail);
      if (miss.length) showNotice(noticeHtml("info", "Данных достаточно, но не всё", `Отсутствует: ${miss.join("; ")}.`));
    }
    stopTicker();
    setStatus(`Матч ${id} разобран${avail.parsed ? "" : " частично"}${fromCache ? " · из кеша" : ""} · ${new Date().toLocaleTimeString("ru-RU")}`);
  } catch (err) {
    if (isStale(run)) return;
    stopTicker();
    const msg = err && err.message === "Отменено" ? "Загрузка отменена." : `Ошибка: ${err && err.message ? err.message : "неизвестная"}`;
    setStatus(msg);
    if (err && err.message !== "Отменено") {
      showNotice(noticeHtml("bad", "Не удалось разобрать матч",
        `${err && err.message ? err.message : "Неизвестная ошибка."} OpenDota иногда отвечает медленно — попробуй ещё раз через несколько секунд.`,
        `<a class="btnGhost" href="${OPENDOTA_MATCH}/${encodeURIComponent(id)}" target="_blank" rel="noopener">Проверить матч на OpenDota</a>`));
    }
  } finally {
    if (!isStale(run)) { stopTicker(); setBusy(false); showSkeleton(false); }
  }
}

/* Кнопка «Запросить разбор»: POST /request + ожидание парсинга с опросом. */
async function runParseRequest(id) {
  const run = beginRun();
  const { signal } = run;
  setBusy(true);
  try {
    showNotice(noticeHtml("info", "Запросили разбор матча у OpenDota", "Парсинг обычно занимает от минуты до нескольких минут. Держи эту вкладку открытой — разбор подхватится автоматически."));
    startTicker("OpenDota разбирает матч…");
    let parsed = null;
    try {
      parsed = await requestParse(id, signal, (i, total) => setTickerText(`OpenDota разбирает матч… попытка ${i} из ${total}`));
    } catch (e) {
      if (e.message === "Отменено") throw e;
      showNotice(noticeHtml("warn", "Не удалось запросить разбор",
        `${e.message} Запрос на парсинг можно отправить вручную: открой матч на OpenDota и нажми «Request parse».`,
        `<a class="btnGhost" href="${OPENDOTA_MATCH}/${encodeURIComponent(id)}" target="_blank" rel="noopener">Открыть матч на OpenDota</a>`));
      stopTicker(); setBusy(false);
      return;
    }
    if (isStale(run)) return;
    stopTicker(); setBusy(false);
    if (parsed) {
      setStatus("Разбор готов, собираем анализ…");
      writeMatchCache(id, parsed);
      await runAnalysis(id, { force: true });
    } else {
      showNotice(noticeHtml("warn", "Разбор пока не готов",
        "OpenDota не успел разобрать матч за отведённое время. Обычно это занимает дольше для старых игр — попробуй ещё раз через пару минут.",
        `<button type="button" class="btnPrimary" id="parseRetry">Попробовать снова</button><a class="btnGhost" href="${OPENDOTA_MATCH}/${encodeURIComponent(id)}" target="_blank" rel="noopener">Открыть на OpenDota</a>`));
    }
  } catch (err) {
    if (isStale(run)) return;
    stopTicker(); setBusy(false);
    if (err.message !== "Отменено") setStatus(`Ошибка: ${err.message}`);
  }
}

/* ------------------------------ ссылка на разбор -------------------------- */
function readMatchFromUrl() {
  const hash = String(location.hash || "").match(/match=(\d+)/);
  if (hash) return hash[1];
  const query = String(location.search || "").match(/[?&]match=(\d+)/);
  return query ? query[1] : null;
}
function writeMatchToUrl(id) {
  try { history.replaceState(null, "", `#match=${id}`); }
  catch (e) { try { location.hash = `match=${id}`; } catch (e2) { } }
}
function shareUrl(id) { return `${location.href.split("#")[0]}#match=${id}`; }
async function copyShareLink() {
  if (!state.matchId) return;
  const url = shareUrl(state.matchId);
  try {
    await navigator.clipboard.writeText(url);
    setStatus("Ссылка на разбор скопирована в буфер обмена.");
  } catch (e) {
    window.prompt("Скопируй ссылку на разбор:", url);
  }
}

/* ---------------------- картинка-вердикт для Telegram --------------------- */
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
async function buildShareCanvas(m, c) {
  const W = 1200, H = 630;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");

  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#0c0e15"); g.addColorStop(0.6, "#101018"); g.addColorStop(1, "#170f0d");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#ff4545"; ctx.fillRect(0, 0, W, 6);

  // герой (если CDN отдаёт с CORS-заголовком)
  let drew = false;
  const img = new Image();
  img.src = heroImg(c); // локальный ассет — тот же origin, канвас не «портится»
  await new Promise(res => { img.onload = res; img.onerror = res; setTimeout(res, 2500); });
  if (img.complete && img.naturalWidth > 0) {
    ctx.save(); rr(ctx, 40, 60, 132, 132, 14); ctx.clip();
    try { ctx.drawImage(img, 40, 60, 132, 132); drew = true; } catch (e) { }
    ctx.restore();
  }
  if (!drew) {
    ctx.fillStyle = "#1d2230"; rr(ctx, 40, 60, 132, 132, 14); ctx.fill();
    ctx.fillStyle = "#ff4545"; ctx.font = "700 64px Arial"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText((heroName(c)[0] || "?").toUpperCase(), 106, 126);
  }

  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.font = "900 64px Arial"; ctx.fillStyle = "#ffffff";
  ctx.fillText("КТО", 200, 120);
  const tw = ctx.measureText("КТО ").width;
  ctx.fillStyle = "#ff4545"; ctx.fillText("РУИНА?", 200 + tw, 120);

  ctx.font = "600 24px Arial"; ctx.fillStyle = "#8a8f9a";
  ctx.fillText(`Match ID ${m.match_id || state.matchId || "—"} · разбор поражения`, 200, 156);

  ctx.font = "900 44px Arial"; ctx.fillStyle = "#ffffff";
  ctx.fillText(c.personaname || "Игрок", 200, 220);
  ctx.font = "600 28px Arial"; ctx.fillStyle = "#c9ccd6";
  ctx.fillText(`${heroName(c)} · ${c.role || ""}`, 200, 258);

  ctx.font = "700 26px Arial"; ctx.fillStyle = "#8a8f9a";
  ctx.fillText("Влияние на поражение", 200, 312);
  const ic = impactClass(c.score);
  ctx.font = "900 72px Arial";
  ctx.fillStyle = (ic === "very-high" || ic === "high") ? "#ff5b5b" : ic === "minimal" ? "#78d39a" : "#ffb45b";
  ctx.fillText(impactLabel(c.score), 200, 392);

  const stats = [
    ["K/D/A", `${c.kills || 0}/${c.deaths || 0}/${c.assists || 0}`],
    ["GPM", fmt(c.gold_per_min)],
    ["Hero DMG", fmt(c.hero_damage)],
    ["Net Worth", fmt(c.net_worth)]
  ];
  let sx = 200;
  for (const [k, v] of stats) {
    ctx.font = "600 20px Arial"; ctx.fillStyle = "#8a8f9a"; ctx.fillText(k, sx, 440);
    ctx.font = "800 30px Arial"; ctx.fillStyle = "#ffffff"; ctx.fillText(String(v), sx, 476);
    sx += 250;
  }

  const reason = c.reasons && c.reasons[0];
  if (reason) {
    ctx.font = "600 22px Arial"; ctx.fillStyle = "#8a8f9a";
    ctx.fillText("Главная причина", 200, 536);
    ctx.font = "700 26px Arial"; ctx.fillStyle = "#ffd7d7";
    ctx.fillText(reason[0], 200, 572);
  }

  ctx.font = "500 18px Arial"; ctx.fillStyle = "#5d626e";
  ctx.fillText("Данные OpenDota · эвристический разбор, а не приговор", 40, H - 28);

  return canvas;
}
async function downloadShareImage() {
  const c = state.lastResult && state.lastResult.culprit;
  const m = state.lastMatch;
  if (!c || !m) { setStatus("Сначала разбери матч."); return; }
  setStatus("Готовим картинку…");
  try {
    const canvas = await buildShareCanvas(m, c);
    const url = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `kto-ruina-${m.match_id || state.matchId}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus("Картинка разбора скачана.");
  } catch (e) {
    setStatus("Не удалось собрать картинку: " + (e && e.message ? e.message : e));
  }
}

/* --------------------------------- запуск -------------------------------- */
function init() {
  // Справочники героев/предметов/рангов уже загружены через data/*.js (в index.html).
  setConstants(window.HEROES_DATA || {}, window.ITEMS_DATA || {}, window.RANK_ICONS || []);
  const form = $("form");
  form.addEventListener("submit", e => {
    e.preventDefault();
    const id = $("matchId").value.trim();
    if (!/^\d{5,}$/.test(id)) { setStatus("Match ID — это число, например 8044236274."); return; }
    runAnalysis(id);
  });
  const cancel = $("cancel");
  cancel && cancel.addEventListener("click", () => { cancelRun(); stopTicker(); setBusy(false); showSkeleton(false); setStatus("Загрузка отменена."); });
  const copy = $("copyLink");
  copy && copy.addEventListener("click", copyShareLink);
  const shareImg = $("shareImage");
  shareImg && shareImg.addEventListener("click", downloadShareImage);

  const notice = $("notice");
  notice && notice.addEventListener("click", e => {
    const t = e.target;
    if (t.closest("#parseBtn") || t.closest("#parseRetry")) runParseRequest(state.matchId);
    else if (t.closest("#refreshBtn")) runAnalysis(state.matchId, { force: true });
  });

  const history = $("history");
  history && history.addEventListener("click", e => {
    const chip = e.target.closest(".histChip");
    if (chip && chip.dataset.id) { $("matchId").value = chip.dataset.id; runAnalysis(chip.dataset.id); }
  });
  renderHistory();

  const fromUrl = readMatchFromUrl();
  if (fromUrl) { $("matchId").value = fromUrl; runAnalysis(fromUrl); }
  else if ($("matchId")) $("matchId").focus();

  // Ссылка на другой разбор в той же вкладке меняет только хеш, поэтому
  // документ не перезагружается — разбор нужно запустить вручную.
  window.addEventListener("hashchange", () => {
    const id = readMatchFromUrl();
    if (id && id !== state.matchId) { $("matchId").value = id; runAnalysis(id); }
  });
}
if (IS_BROWSER) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    isParsed, dataAvailability, availabilityScore, reliabilityLabel, missingDataList,
    inferRoles, inferRole, roleWeights, scorePlayer, analyze, phasesFor, goldGapAt,
    teamKillsIn, teamObjectivesIn, matchStory, buildEvents, overview, setConstants,
    vsOpponent, vsBlock, itemHtml, itemFallback,
    readMatchCache, writeMatchCache, readHistory, writeHistory, pushHistory
  };
}
