#!/usr/bin/env python3
"""Precompute the contact-tracing demo's data from a sim run.

    python3 tracing/build.py [sim/runs/<run_id>]      # writes tracing/out/<run_id>/tracing.json

Uses only what the app could know to trace (phone-detected contacts and reports/tests), plus the
sim's transmission tree, kept separate under "truth" so the page can reveal how tracing did.
Transmission per contact is Rio's dose model (exposure/flu_risk.py), summed per pair per day.
"""
import json
import math
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "exposure"))
import flu_risk  # noqa: E402

DEFAULT_RUN = "influenza_none_n1000_d4_s42_73b8452c"
LOOKBACK_DAYS = 2          # CDC: trace from 2 days before symptom onset / the report
SIX_FT_M = 1.83
QUIET_QUANTA = 1.5         # dorm rooms: sleeping/studying, same as model/infer.js quietQuanta
HUMIDITY, OUTDOOR_TEMP = 60.0, 10.0   # sim defaults (configs/weather.json)
MIN_LAMBDA = 1e-4          # drop negligible pairs from the file


def wkt_ring(wkt):
    """Outer ring of a POLYGON / first polygon of a MULTIPOLYGON, as [lat, lon] pairs."""
    if not isinstance(wkt, str) or "(" not in wkt:
        return None
    body = wkt.lstrip("MULTIPOLYGON ").lstrip("(")
    body = body[: body.index(")")]
    pts = [p.split() for p in body.split(",")]
    return [[round(float(lat), 6), round(float(lon), 6)] for lon, lat in pts]


def main():
    run = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "sim" / "runs" / DEFAULT_RUN
    cfg = json.loads((run / "config.json").read_text())
    step_min = cfg["step_min"]
    steps_per_day = 24 * 60 // step_min

    agents = pd.read_csv(run / "agents_static.csv")
    rep = pd.read_csv(run / "reports_tests.csv")
    inf = pd.read_csv(run / "infections.csv")
    rooms = pd.read_csv(run / "map/rooms.csv").set_index("room_id")
    blds = pd.read_csv(run / "map/buildings.csv").set_index("location_id")

    # Known cases: what the app/Vaden knows, and when.
    sick = rep[((rep.event == "self_report") & rep.value.isin(["might_be_sick", "tested_positive"]))
               | ((rep.event == "test_result") & (rep.value == "positive"))]
    cases = {}
    for a, g in sick.sort_values("t").groupby("agent_id"):
        pos = g[(g.value == "positive") | (g.value == "tested_positive")]
        cases[a] = {"id": a, "t_report": int(g.t.min()),
                    "t_positive": int(pos.t.min()) if len(pos) else None}

    contacts = pd.read_csv(run / "contacts.csv.gz")
    case_ids = set(cases)
    contacts = contacts[contacts.agent_a.isin(case_ids) | contacts.agent_b.isin(case_ids)]

    rows = []
    for c in (contacts.itertuples(index=False)):
        for src, other in ((c.agent_a, c.agent_b), (c.agent_b, c.agent_a)):
            if src not in case_ids:
                continue
            tr = cases[src]["t_report"]
            if not (tr - LOOKBACK_DAYS * steps_per_day <= c.t <= tr + steps_per_day):
                continue
            rows.append((src, other, c))

    pairs = {}
    for src, other, c in rows:
        tr = cases[src]["t_report"]
        day = int(c.t // steps_per_day)
        key = (src, other, day)
        p = pairs.setdefault(key, {"dose": 0.0, "min": 0.0, "min6": 0.0, "dmin": 99.0,
                                   "t0": int(c.t), "t1": int(c.t), "where": {}})
        mins = c.duration_s / 60
        indoor = bool(c.indoor)
        room = c.room_id if isinstance(c.room_id, str) else None
        stage = math.floor((c.t - tr) / steps_per_day)
        if indoor and room is None:
            dose = 0.0                         # across a wall: no shared air
        else:
            r = rooms.loc[room] if room in rooms.index else None
            area = float(r.area_m2) if r is not None else 50.0
            ach = float(r.ventilation_ach) if r is not None else flu_risk.DEFAULT_ACH
            ceiling = float(r.volume_m3) / area if r is not None and r.area_m2 > 0 else flu_risk.CEILING
            quiet = r is not None and str(r.room_type).startswith("dorm")
            dose = flu_risk.contact_dose(mins, float(c.distance_m), area, indoor, stage, HUMIDITY,
                                         OUTDOOR_TEMP, ach, ceiling,
                                         QUIET_QUANTA if quiet else flu_risk.QUANTA_PEAK)
        p["dose"] += dose
        p["min"] += mins
        if c.distance_m <= SIX_FT_M:
            p["min6"] += mins
        p["dmin"] = min(p["dmin"], float(c.distance_m))
        p["t0"], p["t1"] = min(p["t0"], int(c.t)), max(p["t1"], int(c.t))
        loc = c.location_id if isinstance(c.location_id, str) else "outdoors"
        w = p["where"].setdefault(loc, [0.0, room])
        w[0] += mins

    # Truth: who each case actually infected.
    infector_of = dict(zip(inf.infectee_id, inf.infector_id))
    inf_route = dict(zip(inf.infectee_id, inf.route))
    inf_t = dict(zip(inf.infectee_id, inf.t))

    out_contacts = {a: [] for a in cases}
    for (src, other, day), p in pairs.items():
        lam = 1 - math.exp(-p["dose"])
        top = max(p["where"].items(), key=lambda kv: kv[1][0])
        if lam < MIN_LAMBDA and p["min6"] < 15:
            continue
        out_contacts[src].append({
            "other": other, "day": day, "t0": p["t0"], "t1": p["t1"] + 1,
            "minutes": round(p["min"]), "minutes6ft": round(p["min6"]), "closest_m": round(p["dmin"], 1),
            "lambda": round(lam, 5), "where": top[0], "room": top[1][1],
        })
    for a in out_contacts:
        out_contacts[a].sort(key=lambda r: -r["lambda"])

    # Where each case went during their lookback window (stays, from the compact timeline).
    tl = pd.read_csv(run / "timeline_changes.csv.gz",
                     usecols=["t", "agent_id", "location_id", "room_id", "activity", "off_map"])
    tl = tl[tl.agent_id.isin(case_ids)].sort_values(["agent_id", "t"])
    visits = {a: [] for a in cases}
    for a, g in tl.groupby("agent_id"):
        tr = cases[a]["t_report"]
        lo, hi = tr - LOOKBACK_DAYS * steps_per_day, tr
        cur = None
        for r in g.itertuples(index=False):
            loc = r.location_id if isinstance(r.location_id, str) else None
            if cur and cur["loc"] == loc:
                cur["t1"] = int(r.t) + 1
                continue
            if cur and cur["loc"]:
                visits[a].append(cur)
            cur = {"loc": loc, "room": r.room_id if isinstance(r.room_id, str) else None,
                   "act": r.activity, "t0": int(r.t), "t1": int(r.t) + 1}
        if cur and cur["loc"]:
            visits[a].append(cur)
        visits[a] = [v for v in visits[a] if v["t1"] > lo and v["t0"] < hi and v["t1"] - v["t0"] >= 2]
        for v in visits[a]:
            v["t0"], v["t1"] = max(v["t0"], lo), min(v["t1"], hi)

    used = {v["loc"] for vs in visits.values() for v in vs}
    used |= {c["where"] for cs in out_contacts.values() for c in cs}
    buildings = {}
    for loc, b in blds.iterrows():
        ring = wkt_ring(b.footprint_wkt)
        if loc in used or b.type in ("dorm", "dining", "library", "classroom", "lecture_hall", "gym"):
            buildings[loc] = {"name": b["name"] if isinstance(b["name"], str) else loc, "type": b.type,
                              "lat": round(b.lat, 6), "lon": round(b.lon, 6), "ring": ring}

    for a, c in cases.items():
        c["contacts"] = out_contacts[a]
        c["visits"] = visits[a]
        st = agents.set_index("agent_id").loc[a]
        c["archetype"], c["dorm"] = st.archetype, st.home_dorm if isinstance(st.home_dorm, str) else None
        c["infected_by"] = infector_of.get(a)

    truth = {k: {"by": infector_of[k], "route": inf_route[k], "t": int(inf_t[k])}
             for k in infector_of if infector_of[k] != "IMPORT" or inf_route[k] != "seed"}
    out = {
        "run": run.name, "start": cfg["start"], "step_min": step_min, "days": cfg["days"],
        "n_agents": int(cfg["n_agents"]), "lookback_days": LOOKBACK_DAYS, "six_ft_m": SIX_FT_M,
        "has_app": agents.set_index("agent_id").has_app.astype(bool).to_dict(),
        "cases": sorted(cases.values(), key=lambda c: c["t_report"]),
        "buildings": buildings, "truth": truth,
    }
    dest = ROOT / "tracing" / "out" / run.name
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "tracing.json").write_text(json.dumps(out, separators=(",", ":")))
    n = sum(len(c["contacts"]) for c in cases.values())
    print(f"{len(cases)} cases, {n} traced pair-days, {len(buildings)} buildings -> {dest / 'tracing.json'}"
          f" ({(dest / 'tracing.json').stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
