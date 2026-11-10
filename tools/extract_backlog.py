#!/usr/bin/env python3
"""Extrahiert alle User Stories aus docs/03-umsetzungskonzept/umsetzungskonzept.md
nach backlog/backlog.csv und backlog/backlog.json.

Aufruf (aus dem Repo-Wurzelverzeichnis):
    python3 tools/extract_backlog.py

Erwartet Markdown-Tabellen mit den Spalten:
    ID | Story | Akzeptanzkriterien | SP | Prio | Alt
unter Überschriften "## <Nr> Backlog Release <n> ..." und "### <Buchstabe> <Epic-Name>".
"""
import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "docs/03-umsetzungskonzept/umsetzungskonzept.md"
OUT_CSV = ROOT / "backlog/backlog.csv"
OUT_JSON = ROOT / "backlog/backlog.json"

release_re = re.compile(r"^##\s+\d+\s+Backlog Release\s+(\d+)\s*[–-]\s*(.+)$")
epic_re = re.compile(r"^###\s+([A-Z])\s+(.+)$")
row_re = re.compile(r"^\|\s*(R\d-\d{2})\s*\|(.*)\|\s*$")


def cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def main() -> int:
    stories = []
    release = release_name = epic_key = epic_name = None
    for line in SRC.read_text(encoding="utf-8").splitlines():
        if m := release_re.match(line):
            release, release_name = m.group(1), m.group(2).strip()
            epic_key = epic_name = None
            continue
        if line.startswith("## "):
            release = None  # Abschnitt außerhalb des Backlogs
            continue
        if release and (m := epic_re.match(line)):
            epic_key, epic_name = m.group(1), m.group(2).strip()
            continue
        if release and row_re.match(line):
            c = cells(line)
            if len(c) < 6:
                print(f"Zeile unvollständig: {line}", file=sys.stderr)
                continue
            sid, story, ac, sp, prio, alt = c[:6]
            stories.append({
                "id": sid,
                "release": int(release),
                "release_name": release_name,
                "epic": f"{epic_key} {epic_name}",
                "story": story,
                "akzeptanzkriterien": [a.strip() for a in ac.split(";") if a.strip()],
                "story_points": int(sp),
                "prioritaet": prio,
                "alt_id": alt,
            })

    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with OUT_CSV.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["ID", "Release", "Epic", "Story", "Akzeptanzkriterien", "Story Points", "Priorität", "Alt-ID"])
        for s in stories:
            w.writerow([s["id"], s["release"], s["epic"], s["story"], "; ".join(s["akzeptanzkriterien"]),
                        s["story_points"], s["prioritaet"], s["alt_id"]])
    OUT_JSON.write_text(json.dumps(stories, ensure_ascii=False, indent=2), encoding="utf-8")

    total = sum(s["story_points"] for s in stories)
    muss = sum(s["story_points"] for s in stories if s["prioritaet"] == "Muss")
    for r in sorted({s["release"] for s in stories}):
        rs = [s for s in stories if s["release"] == r]
        print(f"Release {r}: {len(rs)} Stories, {sum(s['story_points'] for s in rs)} SP "
              f"({sum(s['story_points'] for s in rs if s['prioritaet'] == 'Muss')} Muss)")
    print(f"Gesamt: {len(stories)} Stories, {total} SP ({muss} Muss)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
