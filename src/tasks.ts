// Cloud Tasks dispatcher for background research jobs, and the OIDC check
// on the receiving end.

import { CloudTasksClient } from '@google-cloud/tasks'
import { OAuth2Client } from 'google-auth-library'

export type Mode = 'new' | 'deepen' | 'retry_write' | 'retry_publish'

/** The JSON payload posted to /tasks/run-research (same field names as the Go version). */
export interface Job {
  line_user_id: string
  topic: string
  mode: Mode
  report_id?: string
  task_id: string
}

/** Cloud Tasks' maximum for HTTP targets; research runs take several minutes. */
export const DISPATCH_DEADLINE_MS = 30 * 60_000

export interface Enqueuer {
  enqueue(job: Job): Promise<void>
}

export class CloudTasksDispatcher implements Enqueuer {
  private readonly client = new CloudTasksClient()
  private readonly queuePath: string
  private readonly targetURL: string
  private readonly audience: string
  private readonly saEmail: string

  constructor(project: string, location: string, queue: string, targetURL: string, audience: string, saEmail: string) {
    this.targetURL = targetURL
    this.audience = audience
    this.saEmail = saEmail
    this.queuePath = this.client.queuePath(project, location, queue)
  }

  async enqueue(job: Job): Promise<void> {
    await this.client.createTask({
      parent: this.queuePath,
      task: {
        dispatchDeadline: { seconds: DISPATCH_DEADLINE_MS / 1000 },
        httpRequest: {
          httpMethod: 'POST',
          url: this.targetURL,
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify(job)).toString('base64'),
          oidcToken: { serviceAccountEmail: this.saEmail, audience: this.audience },
        },
      },
    })
  }
}

export type TokenVerifier = (bearer: string) => Promise<void>

/** Accepts only Google-signed ID tokens for `audience` issued to `saEmail`. */
export function oidcVerifier(audience: string, saEmail: string): TokenVerifier {
  const client = new OAuth2Client()
  return async bearer => {
    const ticket = await client.verifyIdToken({ idToken: bearer, audience })
    const payload = ticket.getPayload()
    if (!payload?.email_verified || payload.email !== saEmail) throw new Error('unexpected token principal')
  }
}
