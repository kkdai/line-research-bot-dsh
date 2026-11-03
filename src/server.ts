// HTTP endpoints:
//
//   POST /webhook             LINE webhook (HMAC-verified)
//   POST /tasks/run-research  Cloud Tasks target (OIDC-verified)
//   GET  /readyz              readiness probe

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { classify } from './intent.ts'
import type { Line } from './line.ts'
import { log } from './log.ts'
import { LockedError, type Store } from './state.ts'
import { DISPATCH_DEADLINE_MS, type Enqueuer, type Job, type Mode, type TokenVerifier } from './tasks.ts'

export interface Runner {
  run(job: Job, signal: AbortSignal): Promise<void>
}

/** Must outlive the Cloud Tasks dispatch deadline so a second job for the same user cannot start meanwhile. */
export const LOCK_TTL_MS = DISPATCH_DEADLINE_MS + 5 * 60_000
const MAX_BODY = 1 << 20

export interface ServerDeps {
  store: Store
  line: Line
  tasks: Enqueuer
  worker: Runner
  /** undefined disables verification (local dev only). */
  verifyToken?: TokenVerifier
}

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new HttpError(413, 'body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

interface LineEvent {
  type?: string
  replyToken?: string
  source?: { userId?: string }
  message?: { type?: string; text?: string }
}

const newTaskId = () => 't-' + randomBytes(6).toString('hex')

export function createHandler(deps: ServerDeps) {
  async function handleEvent(ev: LineEvent): Promise<void> {
    if (ev.type !== 'message') return
    const userId = ev.source?.userId
    if (!userId) throw new Error('event without userId')
    const reply = (text: string) => deps.line.replyText(ev.replyToken ?? '', text)

    if (ev.message?.type !== 'text') return reply('目前只支援文字題目，請用文字描述要研究的主題。')
    const text = ev.message.text ?? ''

    const user = await deps.store.getOrCreateUser(userId)
    const intent = classify(text, { currentReportId: user.currentReportId, pendingAction: user.pendingAction })

    switch (intent) {
      case 'chitchat':
        return reply('哈囉！傳一個研究主題給我吧，例如「研究 SOTA 開源向量資料庫」。')
      case 'recall': {
        if (user.currentReportId) {
          const report = await deps.store.getReport(user.currentReportId)
          if (report) return reply('上次的報告連結：\n' + report.gcs_url)
        }
        return reply('目前沒有進行中的研究。')
      }
      case 'reset':
        await deps.store.setCurrentReport(userId, '')
        await deps.store.setLastInteraction(userId, '')
        await deps.store.setPendingAction(userId, '')
        await deps.store.clearWorkspace(userId)
        return reply('✅ 已清空目前研究。請傳新題目。')
    }

    // new / deepen / retry → background task. Acquire the lock first.
    const taskId = newTaskId()
    try {
      await deps.store.acquireLock(userId, taskId, LOCK_TTL_MS)
    } catch (err) {
      if (err instanceof LockedError) return reply('上一份研究還在跑，請稍候幾分鐘後再傳新題目。')
      throw err
    }

    const job: Job = { line_user_id: userId, topic: text, task_id: taskId, mode: 'new' }
    if (intent === 'deepen') {
      job.mode = 'deepen'
      job.report_id = user.currentReportId
    } else if (intent === 'retry') {
      job.mode = (user.pendingAction || 'retry_write') as Mode
    }

    try {
      await deps.tasks.enqueue(job)
    } catch (err) {
      // Roll back the lock so the user can retry.
      await deps.store.releaseLock(userId).catch(() => {})
      log.error('tasks enqueue failed', { err: String(err) })
      return reply('排程失敗，請稍後再試。')
    }
    return reply('📋 已收到題目，開始規劃…')
  }

  async function webhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req)
    if (!deps.line.verifySignature(body, req.headers['x-line-signature'] as string | undefined)) {
      throw new HttpError(401, 'bad signature')
    }
    let payload: { events?: LineEvent[] }
    try {
      payload = JSON.parse(body.toString('utf8'))
    } catch {
      throw new HttpError(400, 'bad json')
    }
    for (const ev of payload.events ?? []) {
      // Swallow so we still return 200; LINE won't redeliver this batch.
      await handleEvent(ev).catch(err => log.error('event handling failed', { type: ev.type, err: String(err) }))
    }
    json(res, 200, { ok: true })
  }

  async function runResearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (deps.verifyToken) {
      const auth = req.headers.authorization ?? ''
      const ok = auth.startsWith('Bearer ') && await deps.verifyToken(auth.slice(7)).then(() => true, () => false)
      if (!ok) throw new HttpError(401, 'unauthorized')
    }
    let job: Job
    try {
      job = JSON.parse((await readBody(req)).toString('utf8'))
    } catch {
      throw new HttpError(400, 'bad json')
    }
    if (!job.line_user_id || !job.mode) throw new HttpError(400, 'missing fields')

    const signal = AbortSignal.timeout(DISPATCH_DEADLINE_MS - 60_000)
    log.info('job start', { task_id: job.task_id, mode: job.mode })
    try {
      await deps.worker.run(job, signal)
    } catch (err) {
      log.error('job failed', { task_id: job.task_id, err: String(err) })
      throw new HttpError(500, 'job failed')
    } finally {
      await deps.store.releaseLock(job.line_user_id).catch(err => log.error('release lock failed', { err: String(err) }))
    }
    log.info('job done', { task_id: job.task_id })
    json(res, 200, { ok: true })
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    try {
      if (req.method === 'POST' && path === '/webhook') return await webhook(req, res)
      if (req.method === 'POST' && path === '/tasks/run-research') return await runResearch(req, res)
      if (req.method === 'GET' && path === '/readyz') return json(res, 200, { status: 'ok' })
      throw new HttpError(404, 'not found')
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500
      if (status === 500 && !(err instanceof HttpError)) log.error('unhandled', { err: String(err) })
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'text/plain' })
        res.end((err as Error).message)
      }
    }
  }
}
