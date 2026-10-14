#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Скачивает изображения героев, предметов и иконки рангов в локальные папки
проекта и генерирует data/*.js (соответствие id -> имя и локальный путь),
чтобы сайт брал картинки из репозитория, а не с CDN.

Только стандартная библиотека Python (нужен Python 3.7+).

Источники:
  - справочники: github.com/odota/dotaconstants (build/heroes.json, build/items.json)
  - картинки:    cdn.cloudflare.steamstatic.com (Steam CDN)
  - ранги:       www.opendota.com/assets/images/dota2/rank_icons

Использование:
  python tools/fetch-assets.py            # докачать недостающее (пропускает существующие)
  python tools/fetch-assets.py --force    # перекачать всё заново
"""
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

STEAM = "https://cdn.cloudflare.steamstatic.com"
# Иконки рангов берём с зеркала OpenDota на GitHub (opendota.com отдаёт медленно).
RANK_BASE = "https://raw.githubusercontent.com/odota/ui/master/public/assets/images/dota2/rank_icons"
HEROES_URL = "https://raw.githubusercontent.com/odota/dotaconstants/master/build/heroes.json"
ITEMS_URL = "https://raw.githubusercontent.com/odota/dotaconstants/master/build/items.json"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # корень проекта
ASSETS = os.path.join(ROOT, "assets")
DATA = os.path.join(ROOT, "data")
UA = {"User-Agent": "kto-ruina-fetcher/1.0"}


def get(url, timeout=60):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def filename_of(img):
    """'…/heroes/antimage.png?t=123' -> 'antimage.png'."""
    return img.split("?")[0].rstrip("/").split("/")[-1]


def download(url, dest, force):
    if os.path.exists(dest) and not force:
        return False  # уже есть — пропускаем
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    data = get(url)
    with open(dest, "wb") as f:
        f.write(data)
    return True


def hero_name(v):
    return v.get("localized_name") or v.get("name", "").replace("npc_dota_hero_", "").replace("_", " ").title()


def main():
    force = "--force" in sys.argv
    print("Загружаю справочники dotaconstants…")
    heroes = json.loads(get(HEROES_URL))
    items = json.loads(get(ITEMS_URL))
    print(f"героев: {len(heroes)}, предметов: {len(items)}")

    hero_map = {}  # id -> {name, img}
    item_map = {}
    jobs = []      # (url, dest)

    for k, v in heroes.items():
        img = (v.get("img") or "").strip()
        if not img:
            continue
        fn = filename_of(img)
        if not fn:
            continue
        hero_map[str(v.get("id", k))] = {"name": hero_name(v), "img": f"assets/heroes/{fn}"}
        jobs.append((STEAM + img, os.path.join(ASSETS, "heroes", fn)))

    for k, v in items.items():
        img = (v.get("img") or "").strip()
        if not img:
            continue
        fn = filename_of(img)
        if not fn:
            continue
        item_map[str(v.get("id"))] = {"name": v.get("dname") or v.get("localized_name") or fn, "img": f"assets/items/{fn}"}
        jobs.append((STEAM + img, os.path.join(ASSETS, "items", fn)))

    rank_files = [f"rank_icon_{n}.png" for n in range(1, 9)]
    for n in range(1, 9):
        jobs.append((f"{RANK_BASE}/rank_icon_{n}.png", os.path.join(ASSETS, "ranks", f"rank_icon_{n}.png")))

    print(f"Всего файлов: {len(jobs)}. Скачиваю…")
    done = skipped = failed = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(download, url, dest, force): (url, dest) for url, dest in jobs}
        for i, fut in enumerate(as_completed(futs), 1):
            url, dest = futs[fut]
            try:
                if fut.result():
                    done += 1
                else:
                    skipped += 1
            except Exception as e:
                failed += 1
                print(f"  FAIL {os.path.relpath(dest, ROOT)}: {e}")
            if i % 100 == 0:
                print(f"  …{i}/{len(jobs)} ({round(time.time() - t0)}s)")
    print(f"готово: {done} скачано, {skipped} пропущено, {failed} ошибок за {round(time.time() - t0)}с")

    os.makedirs(DATA, exist_ok=True)

    def write_js(path, var, obj):
        with open(path, "w", encoding="utf-8") as f:
            f.write(f"window.{var} = " + json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + ";\n")

    write_js(os.path.join(DATA, "heroes.js"), "HEROES_DATA", hero_map)
    write_js(os.path.join(DATA, "items.js"), "ITEMS_DATA", item_map)
    write_js(os.path.join(DATA, "ranks.js"), "RANK_ICONS", [f"assets/ranks/{f}" for f in rank_files])
    print(f"записано: data/heroes.js ({len(hero_map)}), data/items.js ({len(item_map)}), data/ranks.js ({len(rank_files)})")

    total = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(ASSETS) for f in fs)
    print(f"итоговый размер assets/: {total / 1024 / 1024:.1f} МБ")


if __name__ == "__main__":
    main()
