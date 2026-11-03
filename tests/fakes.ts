// In-memory fakes shared by the worker and server tests.

import type { FlexMessage } from '../src/flex.ts'
import type { Line } from '../src/line.ts'
import type { Publisher } from '../src/publisher.ts'
import type { Agents, Output, PlanResult, SearchResult, WriteInput, WriteResult } from '../src/research/types.ts'
import { LockedError, type Report, type Store, type User, type Workspace } from '../src/state.ts'
import type { Enqueuer, Job } from '../src/tasks.ts'

const emptyUser = (id: string): User => ({ lineUserId: id, currentReportId: '', lastInteractionId: '', pendingAction: '', lastAttemptTopic: '' })

export class FakeStore implements Store {
  users = new Map<string, User>([['U1', emptyUser('U1')]])
  reports = new Map<string, Report>()
  workspaces = new Map<string, Workspace>()
  locks = new Map<string, string>()
  lockedFor = new Set<string>()

  user(id = 'U1') { return this.users.get(id)! }
  async getUser(id: string) { const u = this.users.get(id); return u && { ...u } }
  async getOrCreateUser(id: string) {
    if (!this.users.has(id)) this.users.set(id, emptyUser(id))
    return { ...this.users.get(id)! }
  }
  async setCurrentReport(id: string, r: string) { this.user(id).currentReportId = r }
  async setLastInteraction(id: string, i: string) { this.user(id).lastInteractionId = i }
  async setPendingAction(id: string, a: string) { this.user(id).pendingAction = a }
  async setLastAttemptTopic(id: string, t: string) { this.user(id).lastAttemptTopic = t }
  async acquireLock(id: string, taskId: string) {
    if (this.lockedFor.has(id) || this.locks.has(id)) throw new LockedError('locked')
    this.locks.set(id, taskId)
  }
  async releaseLock(id: string) { this.locks.delete(id) }
  async createReport(reportId: string, userId: string, topic: string, summary: string, gcsURL: string) {
    const now = new Date()
    const r: Report = { reportId, user_id: userId, topic, summary, gcs_url: gcsURL, version: 1, history: [], created_at: now, updated_at: now }
    this.reports.set(reportId, r)
    return r
  }
  async getReport(id: string) { return this.reports.get(id) }
  async deepenReport(id: string, summary: string, snap: string) {
    const r = this.reports.get(id)!
    r.history.push({ version: r.version, gcs_snapshot_url: snap, created_at: new Date() })
    r.version++
    r.summary = summary
    return r
  }
  async getWorkspace(uid: string): Promise<Workspace> {
    return { ...(this.workspaces.get(uid) ?? { topic: '', plan: '', sources: '', report_md: '' }) }
  }
  async saveWorkspace(uid: string, w: Workspace) { this.workspaces.set(uid, { ...w }) }
  async clearWorkspace(uid: string) { this.workspaces.delete(uid) }
}

export class FakeAgents implements Agents {
  planErr?: Error
  searchErr?: Error
  writeErr?: Error
  writeCalls = 0
  lastWrite?: WriteInput
  write: Partial<WriteResult> = {}

  async plan(_u: string, topic: string): Promise<Output<PlanResult>> {
    if (this.planErr) throw this.planErr
    return { value: { topic, queries: [], source_count: 5 }, raw: '{"plan":1}', sessionId: 'ses-plan' }
  }
  async searchCompare(): Promise<Output<SearchResult>> {
    if (this.searchErr) throw this.searchErr
    const value = { sources: [], agreements: [], disagreements: [], gaps: [], source_count: 6, disagreement_count: 2 }
    return { value, raw: '{"sources":[]}', sessionId: 'ses-search' }
  }
  async writeReport(_u: string, input: WriteInput): Promise<Output<WriteResult>> {
    this.writeCalls++
    this.lastWrite = input
    if (this.writeErr) throw this.writeErr
    const w = this.write
    const value: WriteResult = {
      report_id: input.reportID,
      report_md: w.report_md ?? (w.error ? '' : '# report'),
      summary_500: w.summary_500 || 'summary',
      top_citations: w.top_citations ?? [],
      new_version: 1,
      ...(w.added_sources ? { added_sources: w.added_sources } : {}),
      ...(w.error ? { error: w.error } : {}),
      ...(w.available_chapters ? { available_chapters: w.available_chapters } : {}),
    }
    return { value, raw: '{}', sessionId: 'ses-write' }
  }
}

export class FakeLine implements Line {
  texts: string[] = []
  flex: FlexMessage[] = []
  replies: string[] = []
  validSignature = true
  verifySignature() { return this.validSignature }
  async replyText(_t: string, text: string) { this.replies.push(text) }
  async pushText(_u: string, t: string) { this.texts.push(t) }
  async pushFlex(_u: string, m: FlexMessage) { this.flex.push(m) }
}

export class FakePublisher implements Publisher {
  err?: Error
  calls: { reportId: string; md: string; version: number; snapshot: number }[] = []
  async publish(reportId: string, _topic: string, md: string, version: number, snapshot: number) {
    this.calls.push({ reportId, md, version, snapshot })
    if (this.err) throw this.err
    return `https://storage.googleapis.com/b/${reportId}/index.html`
  }
}

export class FakeTasks implements Enqueuer {
  jobs: Job[] = []
  err?: Error
  async enqueue(job: Job) {
    if (this.err) throw this.err
    this.jobs.push(job)
  }
}
