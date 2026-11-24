/* @bruin
name: insights.speaking
type: duckdb.sql
description: Per run and character — turns taken, spoken turns, spoken words (speaker counted separately from turn-taker).
materialization: { type: table }
depends: [raw.turns]
@bruin */
WITH cast_list AS (SELECT r.run_id, c.agent FROM (SELECT DISTINCT run_id FROM raw.turns) r CROSS JOIN (VALUES ('Sam'), ('Welsy'), ('Elizabeth')) c(agent))
SELECT c.run_id, c.agent,
  (SELECT count(*) FROM raw.turns t WHERE t.run_id = c.run_id AND t.agent = c.agent) AS turns_taken,
  (SELECT count(*) FROM raw.turns t WHERE t.run_id = c.run_id AND t.speaker = c.agent) AS spoken_turns,
  (SELECT coalesce(sum(spoken_words), 0) FROM raw.turns t WHERE t.run_id = c.run_id AND t.speaker = c.agent) AS spoken_words
FROM cast_list c
