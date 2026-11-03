# Stage: PLAN

## Research topic
{topic}

## Your task
1. Decide 4-8 specific web search queries that together cover the topic from
   multiple angles (official docs, benchmarks, community reviews, recent news,
   opposing viewpoints).
2. For each query, name the source category (e.g. "official_docs", "benchmark",
   "community_review", "news", "academic").
3. Decide languages to include (default: zh-TW and en; add others only if the
   topic clearly requires).

You do not need to search yet; only design the plan.

## Finish
Call `submit_plan` with:
- `topic`: the original topic
- `queries`: list of objects with `q`, `source_category`, `lang`
- `source_count`: equal to the number of queries
