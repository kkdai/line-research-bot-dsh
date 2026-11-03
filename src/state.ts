// Firestore data layer.
//
// Document shapes match the Go version (line_bot_users, line_bot_reports,
// line_bot_workspaces). The collection prefix is configurable so this bot can
// share a GCP project with the Go bot without mixing their data.

import { randomBytes } from 'node:crypto'
import { Firestore, Timestamp, type CollectionReference } from '@google-cloud/firestore'

export class LockedError extends Error {
  override name = 'LockedError'
}

export interface User {
  lineUserId: string
  currentReportId: string
  lastInteractionId: string
  pendingAction: string
  lastAttemptTopic: string
}

export interface HistoryEntry {
  version: number
  gcs_snapshot_url: string
  created_at: Date
}

export interface Report {
  reportId: string
  user_id: string
  topic: string
  summary: string
  gcs_url: string
  version: number
  history: HistoryEntry[]
  created_at: Date
  updated_at: Date
}

/** The agent's persistent working memory for one user: JSON strings (plan, sources) and Markdown (report_md). */
export interface Workspace {
  topic: string
  plan: string
  sources: string
  report_md: string
}

/** Everything the server and worker need from storage; FirestoreStore implements it, tests fake it. */
export interface Store {
  getUser(id: string): Promise<User | undefined>
  getOrCreateUser(id: string): Promise<User>
  setCurrentReport(id: string, reportId: string): Promise<void>
  setLastInteraction(id: string, interactionId: string): Promise<void>
  setPendingAction(id: string, action: string): Promise<void>
  setLastAttemptTopic(id: string, topic: string): Promise<void>
  acquireLock(id: string, taskId: string, ttlMs: number): Promise<void>
  releaseLock(id: string): Promise<void>
  createReport(reportId: string, userId: string, topic: string, summary: string, gcsURL: string): Promise<Report>
  getReport(reportId: string): Promise<Report | undefined>
  deepenReport(reportId: string, newSummary: string, snapshotURL: string): Promise<Report>
  getWorkspace(userId: string): Promise<Workspace>
  saveWorkspace(userId: string, w: Workspace): Promise<void>
  clearWorkspace(userId: string): Promise<void>
}

export const newReportId = () => randomBytes(16).toString('hex')

const str = (d: Record<string, unknown>, k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '')
const toDate = (v: unknown) => (v instanceof Timestamp ? v.toDate() : v instanceof Date ? v : new Date(0))
const nullable = (v: string) => (v === '' ? null : v)

function userFrom(id: string, d: Record<string, unknown>): User {
  return {
    lineUserId: id,
    currentReportId: str(d, 'current_report_id'),
    lastInteractionId: str(d, 'last_interaction_id'),
    pendingAction: str(d, 'pending_action'),
    lastAttemptTopic: str(d, 'last_attempt_topic'),
  }
}

function reportFrom(id: string, d: Record<string, unknown>): Report {
  const history = Array.isArray(d.history) ? (d.history as Record<string, unknown>[]) : []
  return {
    reportId: id,
    user_id: str(d, 'user_id'),
    topic: str(d, 'topic'),
    summary: str(d, 'summary'),
    gcs_url: str(d, 'gcs_url'),
    version: typeof d.version === 'number' ? d.version : 1,
    history: history.map(h => ({ version: Number(h.version), gcs_snapshot_url: str(h, 'gcs_snapshot_url'), created_at: toDate(h.created_at) })),
    created_at: toDate(d.created_at),
    updated_at: toDate(d.updated_at),
  }
}

export class FirestoreStore implements Store {
  private readonly users: CollectionReference
  private readonly reports: CollectionReference
  private readonly workspaces: CollectionReference
  private readonly db: Firestore
  private readonly now: () => Date

  constructor(db: Firestore, prefix = 'line_bot_', now = () => new Date()) {
    this.db = db
    this.now = now
    this.users = db.collection(`${prefix}users`)
    this.reports = db.collection(`${prefix}reports`)
    this.workspaces = db.collection(`${prefix}workspaces`)
  }

  async getUser(id: string): Promise<User | undefined> {
    const snap = await this.users.doc(id).get()
    return snap.exists ? userFrom(id, snap.data()!) : undefined
  }

  async getOrCreateUser(id: string): Promise<User> {
    const ref = this.users.doc(id)
    return this.db.runTransaction(async tx => {
      const snap = await tx.get(ref)
      if (snap.exists) return userFrom(id, snap.data()!)
      const doc = {
        environment_id: '', current_report_id: null, last_interaction_id: null,
        last_active_at: this.now(), lock: null, pending_action: null,
      }
      tx.set(ref, doc)
      return userFrom(id, doc)
    })
  }

  private async update(id: string, data: Record<string, unknown>): Promise<void> {
    await this.users.doc(id).update(data)
  }

  setCurrentReport(id: string, reportId: string) {
    return this.update(id, { current_report_id: nullable(reportId), last_active_at: this.now() })
  }

  setLastInteraction(id: string, interactionId: string) {
    return this.update(id, { last_interaction_id: interactionId, last_active_at: this.now() })
  }

  setPendingAction(id: string, action: string) {
    return this.update(id, { pending_action: nullable(action) })
  }

  setLastAttemptTopic(id: string, topic: string) {
    return this.update(id, { last_attempt_topic: topic })
  }

  /** Takes the per-user lock, or throws LockedError while another unexpired lock is held. */
  async acquireLock(id: string, taskId: string, ttlMs: number): Promise<void> {
    const ref = this.users.doc(id)
    await this.db.runTransaction(async tx => {
      const snap = await tx.get(ref)
      const now = this.now()
      const lock = snap.data()?.lock as { task_id?: string; lock_until?: unknown } | null | undefined
      if (lock?.lock_until && toDate(lock.lock_until) > now) {
        throw new LockedError(`locked by ${lock.task_id} until ${toDate(lock.lock_until).toISOString()}`)
      }
      tx.update(ref, { lock: { task_id: taskId, lock_until: new Date(now.getTime() + ttlMs) } })
    })
  }

  releaseLock(id: string) {
    return this.update(id, { lock: null })
  }

  async createReport(reportId: string, userId: string, topic: string, summary: string, gcsURL: string): Promise<Report> {
    const now = this.now()
    const doc = { user_id: userId, topic, summary, gcs_url: gcsURL, version: 1, history: [], created_at: now, updated_at: now }
    await this.reports.doc(reportId).set(doc)
    return { reportId, ...doc }
  }

  async getReport(reportId: string): Promise<Report | undefined> {
    const snap = await this.reports.doc(reportId).get()
    return snap.exists ? reportFrom(reportId, snap.data()!) : undefined
  }

  /** Bumps the version, records the previous version's snapshot and stores the new summary. */
  async deepenReport(reportId: string, newSummary: string, snapshotURL: string): Promise<Report> {
    const ref = this.reports.doc(reportId)
    return this.db.runTransaction(async tx => {
      const snap = await tx.get(ref)
      if (!snap.exists) throw new Error(`report ${reportId} not found`)
      const r = reportFrom(reportId, snap.data()!)
      const now = this.now()
      r.history = [...r.history, { version: r.version, gcs_snapshot_url: snapshotURL, created_at: now }]
      r.version += 1
      r.summary = newSummary
      r.updated_at = now
      tx.update(ref, { version: r.version, summary: r.summary, history: r.history, updated_at: now })
      return r
    })
  }

  /** Returns an empty workspace when none exists. */
  async getWorkspace(userId: string): Promise<Workspace> {
    const d = (await this.workspaces.doc(userId).get()).data() ?? {}
    return { topic: str(d, 'topic'), plan: str(d, 'plan'), sources: str(d, 'sources'), report_md: str(d, 'report_md') }
  }

  async saveWorkspace(userId: string, w: Workspace): Promise<void> {
    await this.workspaces.doc(userId).set({ ...w, updated_at: this.now() })
  }

  async clearWorkspace(userId: string): Promise<void> {
    await this.workspaces.doc(userId).delete()
  }
}
