# Мост к OpenDota через Supabase

Edge Function `dota` — такой же тонкий транспорт, как и Cloudflare-воркер в `bridge/`,
но выполняется в твоём проекте Supabase. В `js/app.js` он указан первым приоритетом,
Cloudflare — вторым, прямой OpenDota — третьим.

## Деплой

Установить CLI и войти (токен создаётся на https://supabase.com/dashboard/account/tokens):

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase functions deploy dota --no-verify-jwt
npx supabase secrets set OPENDOTA_KEY=c08698ba-c0c5-4930-8809-3a2b46b60976
```

Либо через дашборд: **Edge Functions → Deploy a new function → Via Editor**,
имя `dota`, вставить содержимое `index.ts`, в **Secrets** добавить `OPENDOTA_KEY`.
Важно: отключить «Enforce JWT Verification» для этой функции (или развернуть с `--no-verify-jwt`),
иначе браузер должен присылать заголовок авторизации.

## Проверка

```bash
curl "https://<ref>.supabase.co/functions/v1/dota/health"
curl "https://<ref>.supabase.co/functions/v1/dota/matches/271145478"
curl "https://<ref>.supabase.co/functions/v1/dota/matches/271145478?force=1"
```

Второй и последующие вызовы одного матча должны отвечать заметно быстрее — это кеш.

## Подключение к сайту

В `js/app.js` указать адрес функции:

```js
const BRIDGE_SUPABASE = "https://<ref>.supabase.co/functions/v1/dota";
```

## Особенности платформы

- Бесплатный проект Supabase **засыпает после недели простоя** — функцию надо разбудить
  в дашборде или пингом снаружи (например, GitHub Actions по расписанию).
- Лимит выполнения функции — 150 с, памяти — 256 МБ, чего для матчей хватает.
- Кеш здесь в памяти изолята (best-effort). Если понадобится общий кеш на все инстансы,
  можно перенести его в таблицу Postgres или в Storage — код для этого готов расширить.
