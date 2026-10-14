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

    const t0 = Date.now();
    const force = url.searchParams.get("force") === "1";
    const isGet = request.method === "GET";
    const cleanUrl = `${UPSTREAM}/${path}`;
    // Ключ OpenDota передаём параметром api_key (API его проверяет: неверный даёт 400).
    // Без ключа OpenDota считает лимит по IP, а у Cloudflare IP общие — поэтому ключ
    // здесь не роскошь, а необходимость.
    const key = env && env.OPENDOTA_KEY;
    const fetchUrl = key ? `${cleanUrl}?api_key=${encodeURIComponent(key)}` : cleanUrl;
    const cache = caches.default;
    const cacheKey = new Request(cleanUrl, { method: "GET" }); // без ключа внутри ключа кеша

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
    // Accept-Encoding: identity — чтобы тело было несжатым и с ним не было
    // путаницы при кешировании (Cloudflare сжимает ответ клиенту сам).
    const headers = { "User-Agent": "kto-ruina-bridge", "Accept-Encoding": "identity" };
    if (key) headers["Authorization"] = `Bearer ${key}`;

    const upstream = await fetch(fetchUrl, { method: request.method, headers });
    const upstreamMs = Date.now() - t0;

    // Диагностика: ?probe=1 замеряет плечо Cloudflare -> OpenDota,
    // но не пересылает большое тело клиенту.
    if (url.searchParams.get("probe") === "1") {
      const buf = await upstream.arrayBuffer();
      return json({
        status: upstream.status,
        upstreamMs,
        totalMs: Date.now() - t0,
        bytes: buf.byteLength,
        keyed: !!key,
        colo: request.cf && request.cf.colo,
      });
    }

    // 3) Чистим заголовки перед отдачей и кешированием:
    //    - set-cookie: OpenDota ставит сессионную куку, а Cloudflare НЕ кеширует
    //      ответы с set-cookie (из-за этого кеш раньше не наполнялся вообще);
    //    - access-control-allow-credentials: true конфликтует с ACAO "*",
    //      и браузер вправе отклонить такой ответ;
    //    - transfer-encoding/connection: рантайм Workers сам размечает поток,
    //      а скопированный chunked приводил к обрыву тела на середине ответа.
    const outHeaders = new Headers(upstream.headers);
    for (const h of [
      "set-cookie", "vary", "content-encoding", "content-length",
      "transfer-encoding", "connection", "keep-alive",
      "access-control-allow-credentials", "access-control-allow-origin",
      "access-control-allow-methods", "access-control-allow-headers", "access-control-max-age",
      "cf-cache-status", "cf-ray", "nel", "report-to", "alt-svc",
    ]) {
      outHeaders.delete(h);
    }
    for (const [k, v] of Object.entries(CORS)) outHeaders.set(k, v);
    outHeaders.set("Cache-Control", isGet ? `public, max-age=${CACHE_TTL}` : "no-store");

    // Тело читаем целиком, чтобы и кеш, и клиент получали корректно
    // размеченный ответ (потоковая отдача из кеша обрывалась на середине).
    const body = await upstream.arrayBuffer();
    const response = new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });

    // Кеш кладём в фоне (ctx.waitUntil): отдача ответа клиенту не должна
    // ждать кеширования. Раньше await cache.put() блокировал запрос на
    // больших телах — клиент висел до таймаута.
    if (isGet && upstream.ok) {
      ctx.waitUntil(cache.put(cacheKey, new Response(body, { status: upstream.status, headers: outHeaders })));
    }
    response.headers.set("X-Bridge", "upstream");
    return response;
  },
};
