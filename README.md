# The Third Survivor

Apple and Kessi's repo for the hackathon (multiplayer-hackthon).

A 2D interactive performance: Sam (aircraft mechanic), Welsy (mountain guide) and Elizabeth
(emergency nurse) survive a plane crash on an island as a storm approaches. Each character is an
independent agent. There is no fixed speaking order: every turn each agent privately bids to act,
one is selected, and only that action and line are performed. 15 turns, then survival is resolved.

## Watch the film

```bash
npm start        # then open http://localhost:3000 (this machine uses PORT=3017) and press Begin
```

`/` plays the featured film (run-02), `/?run=run-NN` another run, `/?live` a run while it is being decided.

Public demo: https://the-third-survivor.lingcode.app/ (replays the recorded performances).

## Publish the demo

```bash
node stage/build-site.mjs      # production build + the recorded runs it replays (private bids stay local)
```

Then deploy the `build/` folder to LingCode Cloud static hosting (the app id is remembered in
`.lingcode/apps.json`, so redeploys update the same URL).

## Make a new performance

```bash
node stage/orchestrate.mjs --seed 103 --model sonnet
```

One command runs the 15 turns with three independent agents (headless `claude -p`), saves the run under
`performance/runs/`, refreshes the Bruin insights, and makes it the film the stage plays by default.

Optional: `node stage/train.mjs --fresh` trains and evaluates the per-character policies over many runs
(results in `performance/insights/training-report.md`). Not needed to make or watch a film.

## Insights (Bruin)

```bash
node stage/insights.mjs        # all runs → bruin/third-survivor (DuckDB) → performance/insights/*.json
```

Tables: `raw.turns`, `raw.outcomes`, `raw.rewards`; views `insights.speaking`, `insights.speaking_overall`,
`insights.plan_changes`, `insights.survival`, `insights.training`.

## Files

- `stage/world.mjs` rules (actions, bids, selection, survival) · `stage/orchestrate.mjs` runs agents
- `stage/policy.mjs` reinforcement learning · `stage/train.mjs` training/evaluation
- `stage/archive.mjs`, `stage/export.mjs` (script + decision log per run), `stage/insights.mjs` (Bruin)
- `stage/voices.mjs` placeholder voices (macOS `say`), `stage/slice-rig.py` and `stage/prepare-scene.py` build assets
- `src/stage/` the canvas renderer (rigs, walking, lip sync, shelter, boat)
- `performance/runs/<id>/` each run: decision-record.json, bids.json (private), policy-trace.json, rewards.json, script.md, decision-log.md, summary.md, voices/
