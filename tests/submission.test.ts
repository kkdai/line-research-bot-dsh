import { describe, expect, it } from 'vitest'
import { assertTurnCompleted, extractSubmission, type EventLike } from '../src/research/submission.ts'
import { AgentError } from '../src/research/types.ts'

// Event shapes as recorded from a real DSH 0.2.1-rc.5 session.
const call = (callId: string, name: string, args: unknown): EventLike =>
  ({ type: 'tool/call', data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) } })
const result = (callId: string, isError: boolean): EventLike =>
  ({ type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: callId, isError, content: [] } } })
const turnEnd = (reason: unknown): EventLike => ({ type: 'turn/end', data: { turn: 1, reason } })

describe('extractSubmission', () => {
  it('returns the last accepted call of the tool', () => {
    const events = [
      call('a', 'web_research', { query: 'q' }), result('a', false),
      call('b', 'submit_plan', { topic: 'old' }), result('b', true),
      call('c', 'submit_plan', { topic: 'new', queries: [], source_count: 0 }), result('c', false),
      turnEnd({ kind: 'completed' }),
    ]
    const out = extractSubmission<{ topic: string }>(events, 'submit_plan')
    expect(out.value.topic).toBe('new')
    expect(JSON.parse(out.raw).topic).toBe('new')
  })

  it('accepts a call whose result has not been recorded', () => {
    expect(extractSubmission<{ x: number }>([call('a', 'submit_report', { x: 1 })], 'submit_report').value.x).toBe(1)
  })

  it('throws AgentError when the tool was never called', () => {
    expect(() => extractSubmission([call('a', 'web_research', {})], 'submit_plan')).toThrow(/without calling submit_plan/)
  })

  it('throws AgentError when every call was rejected', () => {
    expect(() => extractSubmission([call('a', 'submit_plan', {}), result('a', true)], 'submit_plan')).toThrow(AgentError)
  })
})

describe('assertTurnCompleted', () => {
  it('passes a completed turn', () => {
    expect(() => assertTurnCompleted([turnEnd({ kind: 'completed' })])).not.toThrow()
  })

  it('throws on an errored turn', () => {
    const ev = turnEnd({ kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'no API key' } })
    expect(() => assertTurnCompleted([ev])).toThrow(/MISSING_CREDENTIAL no API key/)
  })
})
