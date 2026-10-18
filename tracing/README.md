# Contact tracing demo (Stanford)

When a student tells FlUni they're sick, who should get an alert? This page replays every reported
case in a sim run, looks back 2 days at who they were near, estimates each contact's chance of
catching it with the exposure model (`exposure/flu_risk.py`), and compares two notification rules:

- **CDC close contact**: 15+ minutes within 6 ft in a day.
- **FlUni exposure dose**: chance of infection ≥ a threshold (slider, default 2%). Uses distance,
  time, room size, ventilation, humidity and how contagious the case was that day. Doses from all
  of a pair's meetings in a day are summed and turned into one probability.

Tick **Reveal who was really infected** to score each rule against the simulator's transmission tree.
On the committed 4-day, 1,000-agent run: the dose rule at 2% notifies 270 people and catches 15 of 23
infections the cases caused; the CDC rule notifies 321 and catches 10.

Click a case to see where they went (numbered stops) and their contacts per building; click a contact
to see the phone alert they'd get. Contacts are anonymous; the alert never names the case.

## Run

    python3 -m http.server 8000          # from the repo root
    open http://localhost:8000/tracing/

URL options: `?case=A0863` · `?truth=1` · `?rule=cdc` · `?thr=3` (percent) · `?run=<run_id>`.

## Rebuild the data

    python3 tracing/build.py sim/runs/<run_id>     # writes tracing/out/<run_id>/tracing.json (~1 MB)

Needs pandas. Known cases are self-reports (`might_be_sick`, `tested_positive`) and positive tests.
Contacts come from `contacts.csv.gz` (what phones would detect); `infections.csv` is only used for the
"sim truth" column. Dorm rooms use a quiet emission rate (1.5 q/h, as in `model/`); people on opposite
sides of a wall get no dose.
