"""Exporteert je Carv-sessies (via carv-mcp) naar JS-databestanden voor de lokale webapp.

Draaien met de Python van carv-mcp (zie bijwerken.ps1):
    python -I export_carv.py [--refresh] [--all]

--refresh  vraag Carv om nieuwe sessies (anders alleen wat al lokaal staat)
--all      exporteer alle sessies opnieuw (anders alleen nieuwe)
"""

from __future__ import annotations

import datetime as dt
import json
import sys
import time
from collections import Counter
from pathlib import Path

from carv_mcp import store

OUT = Path(__file__).resolve().parent / "data"
SDIR = OUT / "s"
EXPORT_VERSION = 11


def r(x, n=2):
    return None if x is None else round(float(x), n)


def newest(m: dict, prefix: str) -> dict:
    """Newest generation of e.g. display_metrics_25_to_26."""
    keys = sorted(k for k in m if k.startswith(prefix) and isinstance(m[k], dict))
    return m[keys[-1]] if keys else {}


def path_points(p: list, with_speed: bool, step: int = 1) -> list:
    out = []
    for i, pt in enumerate(p or []):
        if i % step and i != len(p) - 1:
            continue
        lat, lon = pt.get("latitude"), pt.get("longitude")
        if lat is None or lon is None:
            continue
        row = [round(lat, 5), round(lon, 5), r(pt.get("altitude_m"), 0)]
        if with_speed:
            row.append(r((pt.get("speed_mps") or 0) * 3.6, 1))
        out.append(row)
    return out


def edging_curves(tech: dict, step: int = 1) -> dict:
    """Edge angle (degrees, positive = into the turn) of the outside and inside ski through the turn,
    for left and right turns, from Carv's per-ski roll curves (100 points from start to end of the turn).
    In a left turn the right ski is the outside ski; in a right turn the left ski is."""
    def curve(k):
        roll = (tech.get(k) or {}).get("roll") or []
        return [round(roll[i], 1) for i in list(range(0, len(roll), step)) + ([len(roll) - 1] if roll and (len(roll) - 1) % step else [])]
    out = {"lo": curve("left_turn_right_ski"), "li": curve("left_turn_left_ski"),
           "ro": curve("right_turn_left_ski"), "ri": curve("right_turn_right_ski")}
    return {k: v for k, v in out.items() if v}


def app_runs(s: dict) -> list[dict]:
    """The runs as the Carv app lists them. Outdoors (with lifts) these are the 'run' sections.
    Without lifts (indoor slope) Carv stores one long 'run' for the whole session; the laps are
    its 'segment' sections, so those are used as runs."""
    segs = [x["segment"] for x in s.get("sections", []) if "segment" in x]
    if not store.lifts(s) and segs:
        return segs
    return store.runs(s)


def turn_rows(s: dict, runs: list[dict]) -> dict[int, list]:
    off = store.offset(s)
    spans = [((r.get("metrics") or {}).get("start_time"), (r.get("metrics") or {}).get("end_time")) for r in runs]
    per_run: dict[int, list] = {}
    for i, t in enumerate(s.get("turns", [])):
        ts = t.get("start_time")
        run = next((j for j, (a, b) in enumerate(spans) if a and b and ts and a - 1 <= ts <= b + 1), None)
        if run is None:
            continue
        row = store.turn_row(t, i, run, off)
        per_run.setdefault(run, []).append([
            r(row.get("turn_iq"), 1),
            row.get("turn_type"),
            r(row.get("turn_radius_m"), 1),
            r(row.get("speed_kmh"), 1),
            "L" if row.get("direction") == "left" else "R",
        ])
    return per_run


# Detected turn types that count towards each Ski:IQ turn type.
IQ_TYPE_TURNS = {
    "carving": {"GroomedCarving", "Carving"}, "short": {"GroomedShort"}, "mogul": {"Moguls"},
    "powder": {"Powder"}, "parallel": {"GroomedParallel", "UnevenParallel"}, "snowplough": {"Snowplough"},
}


def best_run_iq(runs: list[dict]) -> dict:
    """Per Ski:IQ turn type: the highest run total (the run's own Ski:IQ for that type),
    only over runs in which that turn type was actually skied. Single-turn scores are ignored."""
    best: dict[str, dict] = {}
    for run in runs:
        by_type = (run.get("ski_iq") or {}).get("by_turn_type") or {}
        types = run.get("turn_types") or {}
        for k, names in IQ_TYPE_TURNS.items():
            n = sum(types.get(t, 0) for t in names)
            v = by_type.get(k)
            if n and v is not None and (k not in best or v > best[k]["iq"]):
                best[k] = {"iq": round(v, 2), "run": run["run"], "turns": n}
    return best


def subsegments(s: dict, off: int) -> list[list]:
    """Carv's scored stretches (sub_segments_26, ~8 turns of one type) with their own Ski:IQ.
    The Carv app's Ski:IQ per turn type is the best of these.
    Rows: [turn_type, iq, start, end, turns, impact]; impact = Ski:IQ points per metric
    (Ski:IQ = fixed base per turn type + sum of these points)."""
    out = []
    for sec in s.get("sections", []):
        seg = sec.get("segment") or sec.get("run") or {}
        for sub in seg.get("sub_segments_26") or []:
            v = (sub.get("ski_iq_26") or {}).get("value")
            if v is None:
                continue
            m = sub.get("metrics") or {}
            impact = {k: round(x, 2) for k, x in (m.get("iq_impact_26_to_27") or {}).items() if isinstance(x, (int, float))}
            disp = newest(m, "display_metrics_")
            values = {k: round(disp[k], 3) for k in impact if isinstance(disp.get(k), (int, float))}
            out.append([sub.get("turn_type"), round(v, 2), store.local(m.get("start_time"), off),
                        store.local(m.get("end_time"), off), m.get("no_of_turns"), impact, values,
                        left_right(s, m.get("start_time"), m.get("end_time"), impact)])
    return sorted(out, key=lambda x: x[2] or "")


def left_right(s: dict, t0, t1, keys) -> dict:
    """Per metric the average over the left turns and over the right turns of a stretch:
    {metric: [left, right, n_left, n_right]}. direction 0 (or absent) = left, 1 = right."""
    if not t0 or not t1:
        return {}
    sides: dict[str, tuple[list, list]] = {}
    for t in s.get("turns", []):
        ts = t.get("start_time")
        if not ts or ts < t0 - 0.5 or ts > t1 + 0.5:
            continue
        d = newest(t, "display_")
        right = t.get("direction", 0) == 1
        for k in keys:
            v = d.get(k)
            if isinstance(v, (int, float)):
                sides.setdefault(k, ([], []))[1 if right else 0].append(v)
    return {k: [round(sum(l) / len(l), 3) if l else None, round(sum(r) / len(r), 3) if r else None, len(l), len(r)]
            for k, (l, r) in sides.items()}


def best_sub_iq(subs: list[list]) -> dict:
    """Per Ski:IQ turn type: the best sub-segment score (this matches the Carv app)."""
    best: dict[str, dict] = {}
    for tt, v, start, _end, _n, impact, *_rest in subs:
        for k, names in IQ_TYPE_TURNS.items():
            if tt in names and (k not in best or v > best[k]["iq"]):
                best[k] = {"iq": v, "start": start, "impact": impact}
    return best


def best8(rows: list) -> float | None:
    """Average Turn IQ of the 8 best turns of one descent (not necessarily consecutive); None below 8 turns."""
    v = sorted((x[0] for x in rows if isinstance(x[0], (int, float))), reverse=True)[:8]
    return round(sum(v) / 8, 1) if len(v) == 8 else None


def best8_of_runs(runs: list[dict]) -> float | None:
    vals = [b for b in (best8(r.get("turn_rows") or []) for r in runs) if b is not None]
    return max(vals) if vals else None


def export_session(sid: str) -> dict:
    s = store.session(sid)
    summ = store.session_summary(sid, s)
    off = store.offset(s)
    source = app_runs(s)
    turns = turn_rows(s, source)
    runs = []
    for i, run in enumerate(source):
        m = run.get("metrics", {})
        display = newest(m, "display_metrics_")
        additional = newest(m, "additional_metrics_")
        runs.append({
            **store.rnd(store.run_summary(run, off, i), 2),
            "end": store.local(m.get("end_time"), off),
            "tempo": r(display.get("tempo"), 1),
            "corridor_m": r(additional.get("turn_corridor"), 2),
            "radius_m": r(m.get("turn_radius") or additional.get("turn_radius"), 1),
            "balance": r(additional.get("mid_turn_balance"), 3),
            "edging": edging_curves(m.get("technique") or {}),
            "display": store.rnd(display, 3),
            "additional": store.rnd(additional, 3),
            "path": path_points(run.get("path"), True),
            "turn_rows": turns.get(i, []),
        })
    lifts = []
    for lf in store.lifts(s):
        lifts.append({**store.rnd(store.lift_summary(lf, off), 1), "path": path_points(lf.get("path"), False, 3)})
    # Display metrics for the whole day, weighted by turns per run.
    agg: dict[str, list] = {}
    for run in runs:
        w = run.get("turns") or 0
        for k, v in (run.get("display") or {}).items():
            if isinstance(v, (int, float)) and w:
                agg.setdefault(k, []).append((v, w))
    day_display = {k: round(sum(v * w for v, w in xs) / sum(w for _, w in xs), 3) for k, xs in agg.items()}
    types = Counter()
    for run in runs:
        types.update(run.get("turn_types") or {})
    states = Counter(x.get("state") for x in s.get("states", []))
    subs = subsegments(s, off)
    # Which descent (index in this session) each scored stretch belongs to.
    spans = [(r.get("start"), r.get("end")) for r in runs]
    for x in subs:
        x.append(next((i for i, (a, b) in enumerate(spans) if a and b and x[2] and a <= x[2] <= b), None))
    summ["runs"] = len(runs)
    return {
        "summary": summ,
        "subsegments": subs,
        "best_iq": best_sub_iq(subs),
        "best_run_iq": best_run_iq(runs),
        "display": day_display,
        "turn_types": dict(types.most_common()),
        "airtimes": len(s.get("airtimes") or []),
        "config": {k: (s.get("config") or {}).get(k) for k in ("app_version", "engine_version", "locale")},
        "runs": runs,
        "lifts": lifts,
        "states": dict(states),
    }


def write_js(path: Path, prefix: str, obj) -> None:
    """Writes `prefix<json>);` â€” a script the page loads via <script>, so it also works from file://."""
    tmp = path.with_suffix(".tmp")
    body = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    tmp.write_text(f"{prefix}{body});\n", encoding="utf-8")
    tmp.replace(path)


def main() -> None:
    refresh = "--refresh" in sys.argv
    redo = "--all" in sys.argv
    SDIR.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    print("Sessielijst ophalen" + (" bij Carv..." if refresh else " (lokaal)..."), flush=True)
    idx = store.index(refresh=refresh)
    print(f"{len(idx)} sessies.", flush=True)

    extra: dict[str, dict] = {}
    extra_file = OUT / "extra.json"
    if extra_file.exists() and not redo:
        data = json.loads(extra_file.read_text(encoding="utf-8"))
        if data.get("version") == EXPORT_VERSION:
            extra = data["sessions"]

    done = 0
    for n, summ in enumerate(idx, 1):
        sid = summ["id"]
        target = SDIR / f"{sid}.js"
        if target.exists() and sid in extra and not redo:
            continue
        try:
            d = export_session(sid)
        except Exception as e:  # one broken session should not stop the rest
            print(f"  ! {sid} ({summ.get('date')}): {e}", flush=True)
            continue
        write_js(target, f"CARV.loaded({json.dumps(sid)},", d)
        extra[sid] = {"display": d["display"], "turn_types": d["turn_types"], "best_iq": d["best_iq"],
                      "runs": len(d["runs"]), "best8": best8_of_runs(d["runs"]),
                      # Every scored stretch: [turn type, Ski:IQ, start, {metric: points}, {metric: value}]
                      # [turn type, Ski:IQ, start, points, values, descent index, left/right per metric]
                      "stretches": [[x[0], x[1], x[2], x[5], x[6], x[8], x[7]] for x in d["subsegments"]]}
        done += 1
        if done % 10 == 0:
            print(f"  {n}/{len(idx)} ...", flush=True)
            extra_file.write_text(json.dumps({"version": EXPORT_VERSION, "sessions": extra}), encoding="utf-8")
    # Sessions exported before "best8" existed: compute it from their exported file.
    for sid, e in extra.items():
        target = SDIR / f"{sid}.js"
        if "best8" not in e and target.exists():
            body = target.read_text(encoding="utf-8")
            e["best8"] = best8_of_runs(json.loads(body[body.index(",") + 1:body.rindex(")")])["runs"])
    extra_file.write_text(json.dumps({"version": EXPORT_VERSION, "sessions": extra}), encoding="utf-8")

    # Profile (skier, boots, skis) from the newest session that has one.
    profile = None
    for summ in reversed(idx):
        br = store.light_session(summ["id"]).get("boot_room")
        if br:
            profile = store.rnd(br, 1)
            break

    sessions = []
    for summ in idx:
        e = extra.get(summ["id"])
        if not e:
            continue
        sessions.append({**summ, "season": store.season_of(summ["date"]) if summ.get("date") else None,
                         "display": e["display"], "turn_types": e["turn_types"],
                         "best_iq": e.get("best_iq") or {}, "runs": e.get("runs", summ.get("runs")), "best8": e.get("best8")})
    write_js(OUT / "index.js", "CARV.index(", {
        "generated": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "profile": profile,
        "sessions": sessions,
    })
    # All scored stretches of all sessions, for the "where to gain points" page.
    stretches = []
    for summ in idx:
        e = extra.get(summ["id"]) or {}
        # Descent number within the day (as in the Carv app): earlier sessions that day come first.
        offset = sum((extra.get(o["id"]) or {}).get("runs", 0) for o in idx
                     if o.get("date") == summ.get("date") and (o.get("start") or "") < (summ.get("start") or ""))
        for tt, iq, start, impact, values, run, lr in e.get("stretches") or []:
            descent = offset + run + 1 if run is not None else None
            stretches.append([summ.get("date"), tt, iq, start, impact, values, descent, lr])
    write_js(OUT / "stretches.js", "CARV.stretches(", stretches)
    print(f"Klaar: {done} nieuw geexporteerd, {len(sessions)} in totaal, {time.time() - t0:.0f} s.", flush=True)


if __name__ == "__main__":
    main()
