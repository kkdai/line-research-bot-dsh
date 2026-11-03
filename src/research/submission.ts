// Reads a stage's structured result out of a DSH session's events.
//
// Each stage ends by calling a submit_* tool (dsh/plugin/index.js). DSH
// validates the arguments against the tool's schema before it executes, so a
// call whose tool/result is not an error carries a schema-valid payload.

import { AgentError } from './types.ts'

/** The subset of a DSH SessionEvent this module reads. */
export interface EventLike {
  type: string
  data?: unknown
}

interface ToolCall {
  callId: string
  name: string
  arguments: string
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map(c => (asRecord(c)?.type === 'text' ? String(asRecord(c)?.text ?? '') : '')).join(' ').trim()
}

/** Throws AgentError when the turn ended with an error (provider failure, timeout, ...). */
export function assertTurnCompleted(events: readonly EventLike[]): void {
  for (const e of events) {
    if (e.type !== 'turn/end') continue
    const reason = asRecord(asRecord(e.data)?.reason)
    if (reason?.kind === 'error') {
      const err = asRecord(reason.error)
      throw new AgentError(`agent turn failed: ${String(err?.code ?? '')} ${String(err?.message ?? '')}`.trim())
    }
  }
}

/**
 * Returns the arguments of the last accepted call of `tool`, or throws
 * AgentError when the agent never made one.
 */
export function extractSubmission<T>(events: readonly EventLike[], tool: string): { value: T; raw: string } {
  const calls = new Map<string, ToolCall>()
  const failed = new Map<string, string>()
  for (const e of events) {
    const data = asRecord(e.data)
    if (!data) continue
    if (e.type === 'tool/call' && data.name === tool && typeof data.callId === 'string') {
      calls.set(data.callId, { callId: data.callId, name: tool, arguments: String(data.arguments ?? '') })
    } else if (e.type === 'tool/result') {
      const msg = asRecord(data.message)
      if (msg?.isError === true && typeof msg.toolCallId === 'string') failed.set(msg.toolCallId, contentText(msg.content))
    }
  }
  const accepted = [...calls.values()].filter(c => !failed.has(c.callId))
  const last = accepted.at(-1)
  if (!last) {
    const reasons = [...calls.keys()].map(id => failed.get(id)).filter(Boolean)
    throw new AgentError(calls.size
      ? `every ${tool} call was rejected: ${reasons.at(-1)?.slice(0, 500) ?? ''}`
      : `agent finished without calling ${tool}`)
  }
  let value: T
  try {
    value = JSON.parse(last.arguments) as T
  } catch (err) {
    throw new AgentError(`${tool} arguments are not JSON: ${(err as Error).message}`)
  }
  return { value, raw: JSON.stringify(value) }
}
