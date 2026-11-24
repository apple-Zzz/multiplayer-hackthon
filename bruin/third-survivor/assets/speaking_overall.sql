/* @bruin
name: insights.speaking_overall
type: duckdb.sql
description: Across all runs — who spoke the most (spoken turns and words shown separately).
materialization: { type: table }
depends: [insights.speaking]
@bruin */
SELECT agent, count(*) AS runs, sum(turns_taken) AS turns_taken, sum(spoken_turns) AS spoken_turns, sum(spoken_words) AS spoken_words,
  round(avg(spoken_turns), 2) AS spoken_turns_per_run, round(avg(spoken_words), 1) AS spoken_words_per_run
FROM insights.speaking GROUP BY agent
