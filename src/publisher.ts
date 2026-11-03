// Renders Markdown reports to HTML and uploads them to GCS.

import { Storage, type Bucket } from '@google-cloud/storage'
import { Marked } from 'marked'
import markedFootnote from 'marked-footnote'

const CSS = `
:root { color-scheme: light; }
body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans TC",
                 "PingFang TC", "Hiragino Sans GB", sans-serif;
    max-width: 760px; margin: 0 auto; padding: 32px 24px 80px;
    line-height: 1.7; color: #1f2937; background: #f9fafb;
}
.banner { background: #111827; color: #f9fafb; padding: 8px 16px; border-radius: 8px;
    font-size: 13px; margin-bottom: 24px; display: inline-block; }
h1 { font-size: 28px; margin-top: 24px; }
h2 { font-size: 22px; margin-top: 32px; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
h3 { font-size: 18px; margin-top: 24px; }
p { margin: 12px 0; }
ul, ol { padding-left: 28px; }
a { color: #2563eb; text-decoration: none; }
a:hover { text-decoration: underline; }
code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
pre code { display: block; padding: 12px 16px; overflow-x: auto; }
blockquote { border-left: 4px solid #d1d5db; padding-left: 12px; color: #4b5563; margin: 16px 0; }
table { border-collapse: collapse; width: 100%; margin: 16px 0; }
th, td { border: 1px solid #e5e7eb; padding: 8px 12px; text-align: left; }
th { background: #f3f4f6; }
.footnotes { font-size: 0.9em; }
hr { border: 0; border-top: 1px solid #e5e7eb; margin: 32px 0; }
`

export function escapeHTML(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

const SAFE_URL = /^(https?:|mailto:|#|\/)/i

// GFM + footnotes. Raw HTML in the model's output is escaped, not rendered,
// and links/images are limited to safe URL schemes.
const md = new Marked({ gfm: true })
  .use(markedFootnote())
  .use({
    renderer: {
      html: ({ text }) => escapeHTML(text),
    },
    walkTokens: token => {
      if ((token.type === 'link' || token.type === 'image') && !SAFE_URL.test(token.href)) token.href = '#'
    },
  })

export function renderHTML(topic: string, reportMD: string, version: number, now: Date): string {
  const body = md.parse(reportMD, { async: false })
  const ts = now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
  return `<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHTML(topic)}</title><style>${CSS}</style></head><body><div class="banner">v${version} · 更新於 ${ts}</div>
${body}</body></html>`
}

export const publicURL = (bucket: string, reportId: string) => `https://storage.googleapis.com/${bucket}/${reportId}/index.html`
export const snapshotURL = (bucket: string, reportId: string, version: number) =>
  `https://storage.googleapis.com/${bucket}/${reportId}/snapshots/v${version}.html`

export interface Publisher {
  /**
   * Renders reportMD and uploads it to gs://bucket/reportId/index.html. With
   * snapshotPrevious > 0, the current index.html is first copied to
   * snapshots/v{snapshotPrevious}.html. Returns the public URL.
   */
  publish(reportId: string, topic: string, reportMD: string, version: number, snapshotPrevious: number): Promise<string>
}

export class GCSPublisher implements Publisher {
  private readonly b: Bucket
  private readonly bucket: string

  constructor(storage: Storage, bucket: string) {
    this.bucket = bucket
    this.b = storage.bucket(bucket)
  }

  async publish(reportId: string, topic: string, reportMD: string, version: number, snapshotPrevious: number): Promise<string> {
    if (snapshotPrevious > 0) {
      const src = this.b.file(`${reportId}/index.html`)
      const [exists] = await src.exists()
      if (exists) await src.copy(this.b.file(`${reportId}/snapshots/v${snapshotPrevious}.html`))
    }
    await this.b.file(`${reportId}/index.html`).save(renderHTML(topic, reportMD, version, new Date()), {
      resumable: false,
      metadata: { contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache, max-age=0', contentLanguage: 'zh-TW' },
    })
    return publicURL(this.bucket, reportId)
  }
}
