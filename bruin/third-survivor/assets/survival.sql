/* @bruin
name: insights.survival
type: duckdb.sql
description: Who survived, how, and whether each character met their own goal.
materialization: { type: table }
depends: [raw.outcomes]
@bruin */
SELECT run_id, mode, seed, character_id, character, status, status_label, how, survived, goal_met, goal_score, goal_detail, mobility, radio, water, boat_arrived, shelter_built
FROM raw.outcomes
