// Stage result types (same JSON shapes as the Go/ADK version) and helpers.

export interface Citation {
  title: string
  url: string
}

export interface Query {
  q: string
  source_category: string
  lang: string
}

export interface PlanResult {
  topic: string
  queries: Query[]
  source_count: number
}

export interface Source {
  title: string
  url: string
  lang: string
  summary: string
  key_claims: string[]
}

export interface SearchResult {
  sources: Source[]
  agreements: string[]
  disagreements: unknown[]
  gaps: string[]
  source_count: number
  disagreement_count: number
}

export interface WriteResult {
  report_id: string
  report_md: string
  summary_500: string
  top_citations: Citation[]
  new_version: number
  added_sources?: Source[]
  error?: string
  available_chapters?: string[]
}

export interface WriteInput {
  sourcesJSON: string
  reportMD?: string
  reportID: string
  mode: 'new' | 'deepen'
  previousVersion?: number
  deepenRequest?: string
}

/** A parsed stage result with its raw JSON and the DSH session id (stored as last_interaction_id). */
export interface Output<T> {
  value: T
  raw: string
  sessionId: string
}

export interface Agents {
  plan(userId: string, topic: string, signal: AbortSignal): Promise<Output<PlanResult>>
  searchCompare(userId: string, planJSON: string, signal: AbortSignal): Promise<Output<SearchResult>>
  writeReport(userId: string, input: WriteInput, signal: AbortSignal): Promise<Output<WriteResult>>
}

export const ERR_CHAPTER_NOT_FOUND = 'chapter_not_found'

/** Models occasionally mangle the enum value (e.g. repeat it), so match loosely. */
export function chapterNotFound(w: WriteResult): boolean {
  return (w.error ?? '').includes(ERR_CHAPTER_NOT_FOUND)
}

/** Lists the level-2 headings of a Markdown report. */
export function chapters(reportMD: string): string[] {
  return [...reportMD.matchAll(/^##\s+(.+?)\s*$/gm)].map(m => m[1]!)
}

/** Appends added sources to a sources JSON document; unknown fields are preserved. */
export function mergeSources(sourcesJSON: string, added: Source[] | undefined): string {
  if (!added?.length) return sourcesJSON
  const doc: Record<string, unknown> = sourcesJSON.trim() ? JSON.parse(sourcesJSON) : {}
  const existing = Array.isArray(doc.sources) ? doc.sources : []
  doc.sources = [...existing, ...added]
  doc.source_count = (doc.sources as unknown[]).length
  return JSON.stringify(doc)
}

/** Marks a failure of the agent run itself (model/API error, missing submission) so callers can retry. */
export class AgentError extends Error {
  override name = 'AgentError'
}
