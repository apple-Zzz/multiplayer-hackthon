/* @bruin
name: insights.plan_changes
type: duckdb.sql
description: Who changed plan, where, and the earlier action or line that prompted it (quoted).
materialization: { type: table }
depends: [raw.turns]
columns:
  - { name: run_id, type: varchar, checks: [{ name: not_null }] }
@bruin */
SELECT t.run_id, t.turn, t.agent, t.previous_plan, t.current_plan, t.reason,
  t.influenced_by_turn AS prompted_by_turn, s.agent AS prompted_by_agent,
  s.stage_direction AS prompt_stage_direction, s.spoken_line AS prompt_line,
  t.stage_direction AS resulting_stage_direction
FROM raw.turns t
LEFT JOIN raw.turns s ON s.run_id = t.run_id AND s.turn = t.influenced_by_turn
WHERE t.plan_changed
