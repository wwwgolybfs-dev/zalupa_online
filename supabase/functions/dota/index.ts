// Supabase Edge Function: мост к OpenDota API.
//
// Задача — только транспорт: принять запрос от браузера, сходить в
// api.opendota.com из сети Supabase (датацентр в Нидерландах) и вернуть ответ.
// Никакой логики разбора здесь нет.
//
// Деплой:
//   supabase functions deploy dota --no-verify-jwt
// Секрет с ключом OpenDota (снимает лимит по общему IP):
//   supabase secrets set OPENDOTA_KEY=<ключ>
//
// Вызов из браузера:
//   https://<ref>.supabase.co/functions/v1/dota/matches/123456
//   https://<ref>.supabase.co/functions/v1/dota/matches/123456?force=1

const UPSTREAM = "https://api.opendota.com/api";
const ALLOWED = /^(matches|request|players)\/\d+$/;
const CACHE_TTL_MS = 60 * 60 * 1000; // час

// Кеш в памяти изолята: best-effort (изолятов может быть несколько),
// но повторные запросы в рамках одного изолята отдаются мгновенно.
const cache = new Map<string, { at: number; status: number; body: string }>();

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

/** /functions/v1/dota/matches/123 -> "matches/123" */
function routePath(url: URL): string {
  const i = url.pathname.indexOf("/dota");
  const rest = i >= 0 ? url.pathname.slice(i + "/dota".length) : "";
  return (rest || url.searchParams.get("path") || "").replace(/^\/+|\/+$/g, "");
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const path = routePath(url);

  if (path === "" || path === "health") {
    return json({
      ok: true,
      service: "kto-ruina-supabase-bridge",
      routes: ["matches/{id}", "request/{id}", "players/{id}"],
      cached: cache.size,
    });
  }

  if (!ALLOWED.test(path)) {
    return json({ error: "Разрешены только matches/{id}, request/{id}, players/{id}" }, 403);
  }

  const force = url.searchParams.get("force") === "1";
  const isGet = req.method === "GET";

  if (isGet && !force) {
    const hit = cache.get(path);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return new Response(hit.body, {
        status: hit.status,
        headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "X-Bridge": "hit" },
      });
    }
  }

  const key = Deno.env.get("OPENDOTA_KEY");
  // Ключ передаём параметром api_key: с ним лимит считается по ключу,
  // а не по общему исходящему IP Supabase.
  const target = key ? `${UPSTREAM}/${path}?api_key=${encodeURIComponent(key)}` : `${UPSTREAM}/${path}`;

  const upstream = await fetch(target, {
    method: req.method,
    headers: { "User-Agent": "kto-ruina-supabase-bridge", "Accept-Encoding": "identity" },
  });

  const body = await upstream.text();

  if (isGet && upstream.ok && body.length < 4_000_000) {
    cache.set(path, { at: Date.now(), status: upstream.status, body });
  }

  return new Response(body, {
    status: upstream.status,
    headers: {
      ...CORS,
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "Cache-Control": isGet ? "public, max-age=3600" : "no-store",
      "X-Bridge": "upstream",
    },
  });
});
