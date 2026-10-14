/**
 * КТО РУИНА? — мост к OpenDota API через Cloudflare Workers.
 *
 * Задача воркера — только транспорт: принять запрос от браузера, сходить в
 * api.opendota.com из сети Cloudflare и вернуть ответ. Никакой логики разбора.
 *
 * Почему так:
 *  - у HTTP-запросов воркера нет лимита на длительность, пока клиент подключён,
 *    поэтому медленный ответ OpenDota можно честно дождаться;
 *  - лимита на размер тела ответа нет, матч на несколько мегабайт проходит целиком;
 *  - CPU на free-плане всего 10 мс на запрос, поэтому тело мы НЕ парсим и
 *    НЕ собираем в памяти, а проксируем потоком (ожидание сети в CPU не входит);
 *  - ответы кешируются через Cache API (данные лежат в кеше датацентра Cloudflare),
 *    благодаря чему повторные матчи отдаются мгновенно и не тратят лимиты OpenDota.
 *
 * Разрешены только три безопасных маршрута: matches/{id}, request/{id}, players/{id}.
 */

const UPSTREAM = "https://api.opendota.com/api";
const ALLOWED = /^(matches|request|players)\/\d+$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  // "*" — потому что браузер при cache: "no-store" добавляет Cache-Control/Pragma,
  // и preflight должен пропускать любые заголовки.
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

// Час кеша: разобранный матч не меняется, а неразобранный при необходимости
// обновляется запросом с ?force=1 (кнопка «Обновить» в интерфейсе).
const CACHE_TTL = 3600;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const path = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");

    if (path === "" || path === "health") {
      return json({ ok: true, service: "kto-ruina-bridge", routes: ["matches/{id}", "request/{id}", "players/{id}"] });
    }

    if (!ALLOWED.test(path)) {
      return json({ error: "Разрешены только matches/{id}, request/{id}, players/{id}" }, 403);
    }

    const force = url.searchParams.get("force") === "1";
    const isGet = request.method === "GET";
    const target = `${UPSTREAM}/${path}`;
    const cache = caches.default;
    const cacheKey = new Request(target, { method: "GET" });

    // 1) кеш датацентра Cloudflare
    if (isGet && !force) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const cached = new Response(hit.body, hit);
        for (const [k, v] of Object.entries(CORS)) cached.headers.set(k, v);
        cached.headers.set("X-Bridge", "hit");
        return cached;
      }
    }

    // 2) идём в OpenDota из сети Cloudflare
    const headers = { "User-Agent": "kto-ruina-bridge" };
    if (env && env.OPENDOTA_KEY) headers["Authorization"] = `Bearer ${env.OPENDOTA_KEY}`;

    const upstream = await fetch(target, { method: request.method, headers });

    // 3) отдаём тело потоком, не читая его (экономия CPU)
    const response = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
    for (const [k, v] of Object.entries(CORS)) response.headers.set(k, v);
    response.headers.set("Cache-Control", isGet ? `public, max-age=${CACHE_TTL}` : "no-store");
    response.headers.set("X-Bridge", "upstream");

    if (isGet && upstream.ok) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  },
};
