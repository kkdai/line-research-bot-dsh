// Wiring, HTTP server and graceful shutdown.

import { createServer } from 'node:http'
import { Firestore } from '@google-cloud/firestore'
import { Storage } from '@google-cloud/storage'
import { loadConfig } from './config.ts'
import { LineClient } from './line.ts'
import { log } from './log.ts'
import { GCSPublisher } from './publisher.ts'
import { DshAgents } from './research/agents.ts'
import { createHandler } from './server.ts'
import { FirestoreStore } from './state.ts'
import { CloudTasksDispatcher, oidcVerifier } from './tasks.ts'
import { Worker } from './worker.ts'

const cfg = loadConfig()

const store = new FirestoreStore(new Firestore({ projectId: cfg.gcpProject }), cfg.collectionPrefix)
const line = new LineClient(cfg.lineChannelAccessToken, cfg.lineChannelSecret)
const agents = new DshAgents({
  llmBaseURL: cfg.litellmBaseURL,
  llmApiKey: cfg.litellmApiKey,
  model: cfg.geminiModel,
  gcpProject: cfg.gcpProject,
  gcpLocation: cfg.gcpLocation,
  dshHome: cfg.dshHome,
})
const publisher = new GCSPublisher(new Storage({ projectId: cfg.gcpProject }), cfg.gcsBucket)
const worker = new Worker(store, agents, line, publisher, cfg.gcsBucket)

const targetURL = cfg.serviceURL ? `${cfg.serviceURL.replace(/\/$/, '')}/tasks/run-research` : ''
const tasks = new CloudTasksDispatcher(cfg.gcpProject, cfg.tasksLocation, cfg.tasksQueue, targetURL, cfg.serviceURL, cfg.serviceAccountEmail)

const verifyToken = cfg.serviceURL && cfg.serviceAccountEmail ? oidcVerifier(cfg.serviceURL, cfg.serviceAccountEmail) : undefined
if (!verifyToken) log.warn('CLOUD_RUN_SERVICE_URL / SERVICE_ACCOUNT_EMAIL unset: /tasks/run-research is NOT authenticated (local dev only)')

const server = createServer(createHandler({ store, line, tasks, worker, verifyToken }))
server.requestTimeout = 0 // research jobs hold the request for up to 30 minutes
server.listen(cfg.port, () => log.info('listening', { port: cfg.port, model: cfg.geminiModel, framework: 'deepseek-harness' }))

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    log.info('shutting down', { signal: sig })
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 10_000).unref()
  })
}
