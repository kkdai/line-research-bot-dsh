# Stage: SEARCH_COMPARE

## Research plan (JSON)
{plan}

## Your task
1. For each query in the plan, call `web_research`. Then call `web_research`
   again with `urls` set to the 1-2 most relevant pages it returned, to read
   the actual page content. Independent calls may run in parallel.
2. For each source, record: title, url, language, a ~200-word factual summary,
   and its key claims (as a list).
3. Across all sources, identify:
   - **agreements**: claims supported by at least 2 sources
   - **disagreements**: claims contradicted across sources, with each side's
     claim and supporting source urls
   - **gaps**: questions the topic raises that no source answered

Only include URLs that `web_research` returned. Never invent URLs.

## Finish
Call `submit_sources` with `sources`, `agreements`, `disagreements`, `gaps`,
`source_count` (number of sources) and `disagreement_count` (number of
disagreements).
