// LINE Messaging API wrapper (@line/bot-sdk) and webhook signature check.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { messagingApi } from '@line/bot-sdk'
import type { FlexMessage } from './flex.ts'

/** Checks X-Line-Signature: base64(HMAC-SHA256(channelSecret, body)). */
export function verifySignature(channelSecret: string, body: Buffer, signature: string | undefined): boolean {
  if (!signature) return false
  const expected = createHmac('sha256', channelSecret).update(body).digest()
  const given = Buffer.from(signature, 'base64')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export interface Line {
  verifySignature(body: Buffer, signature: string | undefined): boolean
  replyText(replyToken: string, text: string): Promise<void>
  pushText(userId: string, text: string): Promise<void>
  pushFlex(userId: string, m: FlexMessage): Promise<void>
}

export class LineClient implements Line {
  private readonly api: messagingApi.MessagingApiClient
  private readonly secret: string

  constructor(accessToken: string, secret: string) {
    this.secret = secret
    this.api = new messagingApi.MessagingApiClient({ channelAccessToken: accessToken })
  }

  verifySignature(body: Buffer, signature: string | undefined): boolean {
    return verifySignature(this.secret, body, signature)
  }

  async replyText(replyToken: string, text: string): Promise<void> {
    await this.api.replyMessage({ replyToken, messages: [{ type: 'text', text }] })
  }

  async pushText(userId: string, text: string): Promise<void> {
    await this.api.pushMessage({ to: userId, messages: [{ type: 'text', text }] })
  }

  async pushFlex(userId: string, m: FlexMessage): Promise<void> {
    await this.api.pushMessage({
      to: userId,
      messages: [{ type: 'flex', altText: m.altText, contents: m.contents as unknown as messagingApi.FlexContainer }],
    })
  }
}
