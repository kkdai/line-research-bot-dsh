# Stage: WRITE_REPORT

## Cross-compared sources (JSON)
{sources}

## Current report Markdown (empty for a new report)
{report_md}

## Input
- `report_id`: {report_id}
- `mode`: {mode}
- `previous_version`: {previous_version}
- `deepen_request`: {deepen_request}

## If mode is "new"
Write a complete Markdown report in 繁體中文 with this structure:
- 標題 (H1)
- 摘要（約 500 字）
- 章節 1-N（每章引用至少 2 個來源，使用 Markdown footnote 形式，例如 `[^1]`，
  並在文末定義 `[^1]: 來源標題 URL`）
- 跨來源分歧討論
- 結論與建議
- 來源列表

## If mode is "deepen"
1. Start from the current report Markdown above.
2. Parse `deepen_request` to identify target chapter(s) or change type:
   - If "第 N 章" is mentioned, modify only that chapter.
   - If more sources are requested (e.g. "補 X 來源"), use `web_research` to
     find them, integrate them into the relevant chapters, and list them in
     `added_sources`.
3. If `deepen_request` references a chapter number that does not exist in the
   current report, call `submit_report` with `error` set to
   "chapter_not_found", the existing chapter headings in
   `available_chapters`, and an empty `report_md`.
4. Otherwise return the full rewritten report with the changes applied and a
   regenerated summary.

## Finish
Call `submit_report` with:
- `report_id`: the input report_id
- `report_md`: the FULL Markdown report
- `summary_500`: a ~500-character 繁體中文 summary suitable for a chat message
- `top_citations`: the 3 most important sources (`title`, `url`)
- `new_version`: 1 if mode is "new", otherwise previous_version + 1
- `added_sources`, `error`, `available_chapters`: only when applicable

Do not attempt to upload or publish anything; the host service renders and
publishes the Markdown.
