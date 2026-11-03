import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { progressText, reportCard } from '../src/flex.ts'
import { classify, type Intent, type UserState } from '../src/intent.ts'
import { verifySignature } from '../src/line.ts'
import { publicURL, renderHTML, snapshotURL } from '../src/publisher.ts'
import { fill } from '../src/research/agents.ts'
import { chapters, mergeSources } from '../src/research/types.ts'

describe('classify', () => {
  const none: UserState = { currentReportId: '', pendingAction: '' }
  const active: UserState = { currentReportId: 'r1', pendingAction: '' }
  const pending: UserState = { currentReportId: 'r1', pendingAction: 'retry_write' }
  const cases: [string, string, UserState, Intent][] = [
    ['new keyword', '研究 向量資料庫', none, 'new'],
    ['new keyword with active report', '幫我查 Go ADK', active, 'new'],
    ['deepen', '第 2 章再深一點', active, 'deepen'],
    ['deepen needs report', '第 2 章再深一點', none, 'new'],
    ['reset', '重新開始', active, 'reset'],
    ['recall', '上次的報告呢', active, 'recall'],
    ['retry with pending', '再試一次', pending, 'retry'],
    ['retry without pending is chitchat', '再試一次', active, 'chitchat'],
    ['greeting', 'hi', none, 'chitchat'],
    ['greeting zh', '你好', active, 'chitchat'],
    ['free text no report -> new', '量子電腦的商業化進展', none, 'new'],
    ['free text with report -> chitchat', '量子電腦的商業化進展', active, 'chitchat'],
    ['whitespace trimmed', '  研究 X  ', none, 'new'],
  ]
  it.each(cases)('%s', (_name, msg, st, want) => expect(classify(msg, st)).toBe(want))
})

describe('flex', () => {
  it('progress texts', () => {
    expect(progressText('plan_done', 7)).toBe('🔍 計畫完成：將比對 7 類來源')
    expect(progressText('search_done', 7, 3)).toBe('📊 已比對 7 份來源，發現 3 處重要分歧')
  })

  it('report card truncates the summary and keeps at most 3 complete citations', () => {
    const cites = [
      { title: 'A', url: 'https://a' }, { title: '', url: 'https://b' },
      { title: 'C', url: 'https://c' }, { title: 'D', url: 'https://d' },
    ]
    const card = reportCard('主題', '字'.repeat(500), 'https://report', cites, 2)
    const json = JSON.stringify(card.contents)
    expect(card.altText).toBe('📝 主題 研究報告已完成')
    expect(json).toContain('字'.repeat(400) + '…')
    expect(json).toContain('"v2"')
    expect(json).toContain('https://a')
    expect(json).toContain('https://c')
    expect(json).not.toContain('https://b')
    expect(json).not.toContain('https://d')
  })

  it('report card without citations has no sources section', () => {
    expect(JSON.stringify(reportCard('t', 's', 'https://r', [], 1).contents)).not.toContain('主要來源')
  })
})

describe('verifySignature', () => {
  const body = Buffer.from('{"events":[]}')
  const sig = createHmac('sha256', 'secret').update(body).digest('base64')
  it('accepts the right signature', () => expect(verifySignature('secret', body, sig)).toBe(true))
  it('rejects a wrong secret', () => expect(verifySignature('other', body, sig)).toBe(false))
  it('rejects missing or garbage', () => {
    expect(verifySignature('secret', body, undefined)).toBe(false)
    expect(verifySignature('secret', body, 'xx')).toBe(false)
  })
})

describe('publisher', () => {
  it('renders GFM, footnotes and the version banner, escaping raw HTML and unsafe links', () => {
    const md = '# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n文字[^1]\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n[^1]: 來源 https://example.com\n'
    const html = renderHTML('<主題>', md, 3, new Date('2026-11-03T10:20:00Z'))
    expect(html).toContain('<title>&lt;主題&gt;</title>')
    expect(html).toContain('v3 · 更新於 2026-11-03 10:20 UTC')
    expect(html).toContain('<table>')
    expect(html).toContain('footnote')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('javascript:')
  })

  it('builds public and snapshot URLs', () => {
    expect(publicURL('b', 'r')).toBe('https://storage.googleapis.com/b/r/index.html')
    expect(snapshotURL('b', 'r', 2)).toBe('https://storage.googleapis.com/b/r/snapshots/v2.html')
  })
})

describe('research helpers', () => {
  it('lists level-2 chapters', () => {
    expect(chapters('# T\n## 一、背景\ntext\n### sub\n## 二、比較 \n')).toEqual(['一、背景', '二、比較'])
  })

  it('merges added sources and keeps unknown fields', () => {
    const merged = JSON.parse(mergeSources('{"sources":[{"url":"a"}],"gaps":["g"]}', [
      { title: 't', url: 'b', lang: 'en', summary: 's', key_claims: [] },
    ]))
    expect(merged.sources.map((s: { url: string }) => s.url)).toEqual(['a', 'b'])
    expect(merged.source_count).toBe(2)
    expect(merged.gaps).toEqual(['g'])
    expect(mergeSources('{"x":1}', [])).toBe('{"x":1}')
  })

  it('fills placeholders once, leaving braces in inserted JSON alone', () => {
    expect(fill('P {plan} {unknown}', { plan: '{"topic":"{plan}"}' })).toBe('P {"topic":"{plan}"} {unknown}')
  })

  it('prompts only use placeholders the agents fill', () => {
    const known: Record<string, string[]> = {
      plan: ['topic'],
      search_compare: ['plan'],
      write_report: ['sources', 'report_md', 'report_id', 'mode', 'previous_version', 'deepen_request'],
      persona: [],
    }
    for (const [name, keys] of Object.entries(known)) {
      const text = readFileSync(join(import.meta.dirname, '../src/research/prompts', `${name}.md`), 'utf8')
      const used = [...text.matchAll(/\{([a-z_]+)\}/g)].map(m => m[1])
      expect(new Set(used), name).toEqual(new Set(keys))
    }
  })
})

describe('renderPatch', () => {
  it('writes the patch with the plugin file URL and no placeholder', async () => {
    const { mkdtempSync, readFileSync: read } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { renderPatch } = await import('../src/research/agents.ts')
    const path = await renderPatch(join(mkdtempSync(join(tmpdir(), 'dsh-')), 'home'))
    const text = read(path, 'utf8')
    expect(text).not.toContain('{{PLUGIN_URL}}')
    expect(text).toMatch(/name: 'file:\/\/\/.*\/dsh\/plugin\/index\.js'/)
  })
})

describe('runtimeEnv', () => {
  it('drops app secrets from the DSH runtime env', async () => {
    const { runtimeEnv } = await import('../src/research/agents.ts')
    const env = runtimeEnv({ PATH: '/bin', LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', LITELLM_MASTER_KEY: 'k' })
    expect(env).toEqual({ PATH: '/bin' })
  })
})
