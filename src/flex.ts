// LINE progress texts and the final report Flex card (ported from Go).

import type { Citation } from './research/types.ts'

export type Stage = 'planning' | 'plan_done' | 'search_done' | 'writing'

export function progressText(stage: Stage, sourceCount = 0, disagreementCount = 0): string {
  switch (stage) {
    case 'planning': return '📋 已收到題目，開始規劃…'
    case 'plan_done': return `🔍 計畫完成：將比對 ${sourceCount} 類來源`
    case 'search_done': return `📊 已比對 ${sourceCount} 份來源，發現 ${disagreementCount} 處重要分歧`
    case 'writing': return '📝 正在撰寫報告…'
  }
}

export interface FlexMessage {
  altText: string
  contents: Record<string, unknown>
}

const MAX_SUMMARY_CHARS = 400

export function reportCard(topic: string, summary: string, reportURL: string, citations: Citation[] | undefined, version: number): FlexMessage {
  const chars = [...summary]
  if (chars.length > MAX_SUMMARY_CHARS) summary = chars.slice(0, MAX_SUMMARY_CHARS).join('') + '…'

  const body: unknown[] = [
    {
      type: 'box', layout: 'horizontal',
      contents: [
        { type: 'text', text: topic, weight: 'bold', size: 'lg', wrap: true, flex: 5 },
        { type: 'text', text: `v${version}`, size: 'sm', color: '#888888', align: 'end', flex: 1 },
      ],
    },
    { type: 'separator', margin: 'md' },
    { type: 'text', text: summary, wrap: true, size: 'sm', margin: 'md' },
  ]

  const cites = (citations ?? [])
    .slice(0, 3)
    .filter(c => c.url && c.title)
    .map(c => ({ type: 'text', text: '• ' + c.title, wrap: true, size: 'xs', color: '#666666', action: { type: 'uri', uri: c.url } }))
  if (cites.length) {
    body.push(
      { type: 'separator', margin: 'md' },
      { type: 'text', text: '主要來源', size: 'xs', color: '#888888', margin: 'md' },
      ...cites,
    )
  }

  return {
    altText: `📝 ${topic} 研究報告已完成`,
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', contents: body },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [{ type: 'button', style: 'primary', action: { type: 'uri', label: '閱讀完整報告', uri: reportURL } }],
      },
    },
  }
}
