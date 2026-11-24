/* @bruin
name: insights.training
type: duckdb.sql
description: Survival and goal-completion rate per character before training (starting policy), during training, and after (learned policy), with the number of runs behind each rate.
materialization: { type: table }
depends: [raw.outcomes, raw.rewards]
@bruin */
SELECT o.character_id, o.character,
  CASE o.mode WHEN 'baseline' THEN 'starting policy' WHEN 'train' THEN 'training (exploring)' WHEN 'learned' THEN 'learned policy' END AS phase,
  CASE o.mode WHEN 'baseline' THEN 1 WHEN 'train' THEN 2 WHEN 'learned' THEN 3 END AS phase_order,
  count(*) AS runs,
  round(avg(CASE WHEN o.survived THEN 1.0 ELSE 0.0 END), 3) AS survival_rate,
  round(avg(CASE WHEN o.goal_met THEN 1.0 ELSE 0.0 END), 3) AS goal_rate,
  round(avg(r.survival_reward), 3) AS mean_survival_reward,
  round(avg(r.goal_reward), 3) AS mean_goal_reward,
  round(avg(r.total_reward), 3) AS mean_total_reward,
  string_agg(DISTINCT CAST(o.seed AS VARCHAR), ',') AS seeds
FROM raw.outcomes o
LEFT JOIN raw.rewards r ON r.run_id = o.run_id AND r.character_id = o.character_id
WHERE o.mode IN ('baseline', 'train', 'learned')
GROUP BY o.character_id, o.character, o.mode
