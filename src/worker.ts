// Orchestrates one Cloud Tasks job: PLAN → SEARCH_COMPARE → WRITE_REPORT →
// publish, plus deepen and retries. Ported from the Go worker; the user-facing
// behaviour and messages are unchanged.

import { progressText, reportCard, type FlexMessage } from './flex.ts'
import { log } from './log.ts'
import type { Line } from './line.ts'
import { publicURL, snapshotURL, type Publisher } from './publisher.ts'
import { chapterNotFound, chapters, mergeSources, type Agents, type Output, type WriteResult } from './research/types.ts'
import { newReportId, type Store, type User, type Workspace } from './state.ts'
import type { Job } from './tasks.ts'

export interface Timeouts {
  planMs: number
  searchMs: number
  writeMs: number
  retryWaitMs: number
}

export const DEFAULT_TIMEOUTS: Timeouts = { planMs: 3 * 60_000, searchMs: 10 * 60_000, writeMs: 8 * 60_000, retryWaitMs: 2_000 }

const EXPIRED_TEXT = '上次研究檔案已過期，重新從頭研究 🔄'

export class Worker {
  newId: () => string = newReportId
  private readonly store: Store
  private readonly agents: Agents
  private readonly line: Line
  private readonly publisher: Publisher
  private readonly bucket: string
  private readonly timeouts: Timeouts

  constructor(store: Store, agents: Agents, line: Line, publisher: Publisher, bucket: string, timeouts: Timeouts = DEFAULT_TIMEOUTS) {
    this.store = store
    this.agents = agents
    this.line = line
    this.publisher = publisher
    this.bucket = bucket
    this.timeouts = timeouts
  }

  /**
   * Runs a job. User-facing failures (agent/publish) are reported to LINE and
   * resolve normally; infrastructure errors reject so Cloud Tasks retries.
   */
  async run(job: Job, signal: AbortSignal): Promise<void> {
    const user = await this.store.getUser(job.line_user_id)
    if (!user) throw new Error(`user ${job.line_user_id} not found`)
    switch (job.mode) {
      case 'new': return this.runNew(user.lineUserId, job.topic, signal)
      case 'deepen': return this.runDeepen(user, job.report_id ?? '', job.topic, signal)
      case 'retry_write': return this.runRetryWrite(user, signal)
      case 'retry_publish': return this.runRetryPublish(user, signal)
      default: throw new Error(`unknown mode: ${String(job.mode)}`)
    }
  }

  // push and pushCard only log LINE failures: rejecting would make Cloud
  // Tasks re-run the whole (slow, billed) research pipeline.
  private async push(userId: string, text: string): Promise<void> {
    await this.line.pushText(userId, text).catch(err => log.error('line push failed', { err: String(err) }))
  }

  private async pushCard(userId: string, m: FlexMessage): Promise<void> {
    await this.line.pushFlex(userId, m).catch(err => log.error('line push flex failed', { err: String(err) }))
  }

  private async withRetry<T>(attempts: number, timeoutMs: number, signal: AbortSignal, fn: (s: AbortSignal) => Promise<T>): Promise<T> {
    let lastErr: unknown
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, this.timeouts.retryWaitMs))
      signal.throwIfAborted()
      try {
        return await fn(AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]))
      } catch (err) {
        lastErr = err
        log.warn('agent attempt failed', { attempt: i + 1, err: String(err) })
        if (signal.aborted) break
      }
    }
    throw lastErr
  }

  // ---------------- new research ----------------

  private async runNew(userId: string, topic: string, signal: AbortSignal): Promise<void> {
    await this.store.setLastAttemptTopic(userId, topic)

    // Stage 1: PLAN (single attempt; surface failure immediately)
    let plan
    try {
      plan = await this.withRetry(1, this.timeouts.planMs, signal, s => this.agents.plan(userId, topic, s))
    } catch (err) {
      log.error('plan failed', { err: String(err) })
      await this.push(userId, '規劃失敗，請換個說法重試。')
      return
    }
    const ws: Workspace = { topic, plan: plan.raw, sources: '', report_md: '' }
    await this.store.saveWorkspace(userId, ws)
    await this.store.setLastInteraction(userId, plan.sessionId).catch(() => {})
    const sourceCount = plan.value.source_count || plan.value.queries.length
    await this.push(userId, progressText('plan_done', sourceCount))

    // Stage 2: SEARCH_COMPARE (2 attempts)
    let search
    try {
      search = await this.withRetry(2, this.timeouts.searchMs, signal, s => this.agents.searchCompare(userId, ws.plan, s))
    } catch (err) {
      log.error('search_compare failed', { err: String(err) })
      await this.push(userId, '搜尋比對失敗，請稍後再試。')
      return
    }
    ws.sources = search.raw
    await this.store.saveWorkspace(userId, ws)
    await this.store.setLastInteraction(userId, search.sessionId).catch(() => {})
    await this.push(userId, progressText('search_done', search.value.source_count, search.value.disagreement_count))

    // Stage 3: WRITE_REPORT (2 attempts) + publish
    return this.writeAndPublishNew(userId, topic, ws, true, signal)
  }

  /**
   * Runs WRITE_REPORT in "new" mode and publishes v1. fromPipeline tells the
   * first run (sets pending actions on failure) from a "retry_write" job.
   */
  private async writeAndPublishNew(userId: string, topic: string, ws: Workspace, fromPipeline: boolean, signal: AbortSignal): Promise<void> {
    const reportId = this.newId()
    let write: Output<WriteResult>
    try {
      write = await this.withRetry(2, this.timeouts.writeMs, signal, s =>
        this.agents.writeReport(userId, { sourcesJSON: ws.sources, reportID: reportId, mode: 'new' }, s))
    } catch (err) {
      log.error('write_report failed', { err: String(err) })
      await this.store.setPendingAction(userId, 'retry_write')
      await this.push(userId, '資料已找齊，組稿失敗，回『再試一次』可再試。')
      return
    }
    const wr = write.value
    await this.store.setLastInteraction(userId, write.sessionId).catch(() => {})
    ws.report_md = nonEmptyReport(wr.report_md, topic)
    await this.store.saveWorkspace(userId, ws)

    let gcsURL: string
    try {
      gcsURL = await this.publisher.publish(reportId, topic, ws.report_md, 1, 0)
    } catch (err) {
      log.error('publish failed', { err: String(err) })
      if (!fromPipeline) {
        await this.push(userId, '組稿完成但發佈失敗，請稍後重試。')
        return
      }
      await this.store.setPendingAction(userId, 'retry_publish')
      await this.store.createReport(reportId, userId, topic, '(尚未發佈成功)', publicURL(this.bucket, reportId))
      await this.store.setCurrentReport(userId, reportId)
      await this.push(userId, '報告寫好但發佈失敗，回『再發佈一次』可再試。')
      return
    }

    if (!fromPipeline) await this.store.setPendingAction(userId, '')
    await this.store.createReport(reportId, userId, topic, wr.summary_500, gcsURL)
    await this.store.setCurrentReport(userId, reportId)
    await this.pushCard(userId, reportCard(topic, wr.summary_500, gcsURL, wr.top_citations, 1))
  }

  /** A missing workspace: tell the user and start the research over. */
  private async restartIfExpired(userId: string, topic: string, signal: AbortSignal): Promise<void> {
    await this.push(userId, EXPIRED_TEXT)
    return this.runNew(userId, topic, signal)
  }

  // ---------------- deepen ----------------

  private async runDeepen(user: User, reportId: string, request: string, signal: AbortSignal): Promise<void> {
    if (!reportId) throw new Error('deepen requires report_id')
    const existing = await this.store.getReport(reportId)
    if (!existing) throw new Error(`report ${reportId} not found`)
    const userId = user.lineUserId
    await this.store.setLastAttemptTopic(userId, existing.topic)
    const ws = await this.store.getWorkspace(userId)
    if (!ws.sources || !ws.report_md) return this.restartIfExpired(userId, existing.topic, signal)
    const prev = existing.version

    let write: Output<WriteResult>
    try {
      write = await this.withRetry(1, this.timeouts.writeMs, signal, s => this.agents.writeReport(userId, {
        sourcesJSON: ws.sources, reportMD: ws.report_md, reportID: reportId,
        mode: 'deepen', previousVersion: prev, deepenRequest: request,
      }, s))
    } catch (err) {
      log.error('deepen write failed', { err: String(err) })
      await this.push(userId, '深化失敗，請稍後再試。')
      return
    }
    const wr = write.value
    await this.store.setLastInteraction(userId, write.sessionId).catch(() => {})

    if (chapterNotFound(wr)) {
      const list = wr.available_chapters?.length ? wr.available_chapters : chapters(ws.report_md)
      await this.push(userId, '找不到指定章節。目前報告章節如下：\n' + list.join('\n'))
      return
    }
    if (!wr.report_md.trim()) {
      log.error('deepen returned empty report', { error_field: wr.error ?? '' })
      await this.push(userId, '深化失敗，請稍後再試。')
      return
    }

    const newVersion = prev + 1
    const reportMD = nonEmptyReport(wr.report_md, existing.topic)
    try {
      await this.publisher.publish(reportId, existing.topic, reportMD, newVersion, prev)
    } catch (err) {
      log.error('deepen publish failed', { err: String(err) })
      await this.push(userId, '深化完成但發佈失敗，請稍後重試。')
      return
    }

    ws.report_md = reportMD
    try {
      ws.sources = mergeSources(ws.sources, wr.added_sources)
    } catch (err) {
      log.warn('merge added sources failed', { err: String(err) })
    }
    await this.store.saveWorkspace(userId, ws)
    await this.store.deepenReport(reportId, wr.summary_500, snapshotURL(this.bucket, reportId, prev))
    await this.pushCard(userId, reportCard(existing.topic, wr.summary_500, existing.gcs_url, wr.top_citations, newVersion))
  }

  // ---------------- retry_write ----------------

  private async runRetryWrite(user: User, signal: AbortSignal): Promise<void> {
    const ws = await this.store.getWorkspace(user.lineUserId)
    if (!ws.sources) return this.restartIfExpired(user.lineUserId, user.lastAttemptTopic, signal)
    return this.writeAndPublishNew(user.lineUserId, user.lastAttemptTopic, ws, false, signal)
  }

  // ---------------- retry_publish ----------------

  /** Re-publishes the report Markdown kept in the workspace; no agent call is needed. */
  private async runRetryPublish(user: User, signal: AbortSignal): Promise<void> {
    if (!user.currentReportId) throw new Error('retry_publish requires a current report')
    const report = await this.store.getReport(user.currentReportId)
    if (!report) throw new Error(`report ${user.currentReportId} not found`)
    const ws = await this.store.getWorkspace(user.lineUserId)
    if (!ws.report_md) return this.restartIfExpired(user.lineUserId, report.topic, signal)
    let gcsURL: string
    try {
      gcsURL = await this.publisher.publish(report.reportId, report.topic, ws.report_md, report.version, 0)
    } catch (err) {
      log.error('republish failed', { err: String(err) })
      await this.push(user.lineUserId, '再次發佈失敗，請稍後重試。')
      return
    }
    await this.store.setPendingAction(user.lineUserId, '')
    await this.push(user.lineUserId, '✅ 已重新發佈：' + gcsURL)
  }
}

function nonEmptyReport(md: string, topic: string): string {
  return md ? md : `# ${topic}\n\n(報告內容缺失)`
}
