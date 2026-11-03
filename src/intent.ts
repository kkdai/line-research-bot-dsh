// Keyword intent classifier (ported 1:1 from the Go version).

export type Intent = 'new' | 'deepen' | 'reset' | 'recall' | 'retry' | 'chitchat'

export interface UserState {
  /** '' when there is no active report */
  currentReportId: string
  /** '', 'retry_write' or 'retry_publish' */
  pendingAction: string
}

const NEW = ['研究', '幫我查', '找一下']
const DEEPEN = ['深化', '補', '改', '第']
const RESET = ['重新開始', '換題目', '清除']
const RECALL = ['上次', '我之前', '連結']
const RETRY = ['再試一次', '再發佈一次']
const GREETING = ['你好', '嗨', 'hi', 'hello', '哈囉']

const containsAny = (s: string, ks: string[]) => ks.some(k => s.includes(k))
const hasAnyPrefix = (s: string, ks: string[]) => ks.some(k => s.startsWith(k))

export function classify(message: string, st: UserState): Intent {
  const m = message.trim()
  if (st.pendingAction && containsAny(m, RETRY)) return 'retry'
  if (hasAnyPrefix(m, RESET)) return 'reset'
  if (containsAny(m, RECALL)) return 'recall'
  if (st.currentReportId && hasAnyPrefix(m, DEEPEN)) return 'deepen'
  if (hasAnyPrefix(m, NEW)) return 'new'
  // Count code points, not UTF-16 units.
  if ([...m].length < 5 && containsAny(m.toLowerCase(), GREETING)) return 'chitchat'
  if (!st.currentReportId) return 'new'
  return 'chitchat'
}
