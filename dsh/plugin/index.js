// DeepSeek Harness (Cordis) plugin mounted by dsh/research.patch.yml.
//
// It runs inside the `dsh` runtime subprocess, not in the web server. It
// registers four model-facing tools:
//
//   web_research    Gemini on Vertex AI with Google Search + URL context.
//                   This keeps the search grounding the ADK version had,
//                   independent of the chat model behind LiteLLM.
//   submit_plan     \
//   submit_sources   > Structured stage results. DSH validates the arguments
//   submit_report   /  against the schema; the host reads the accepted call
//                      out of the session events (src/research/submission.ts).
//
// Plain JavaScript on purpose: Node does not strip types for files loaded
// through node_modules.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { GoogleGenAI } from '@google/genai'

export const name = 'line-research-tools'
export const inject = ['tools']

const REDIRECT_HOST = 'vertexaisearch.cloud.google.com'

/** @param {string} url */
async function resolveRedirect(url, signal) {
  if (!url.includes(REDIRECT_HOST)) return url
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) })
    return res.headers.get('location') ?? url
  } catch {
    return url
  }
}

const source = {
  type: 'object',
  additionalProperties: true,
  properties: {
    title: { type: 'string', required: true, description: 'page title' },
    url: { type: 'string', required: true, description: 'page url, exactly as retrieved' },
    lang: { type: 'string', required: true, description: 'language code, e.g. en, zh-TW' },
    summary: { type: 'string', required: true, description: '~200-word factual summary' },
    key_claims: { type: 'array', required: true, items: { type: 'string' } },
  },
}

const citation = {
  type: 'object',
  additionalProperties: true,
  properties: {
    title: { type: 'string', required: true },
    url: { type: 'string', required: true },
  },
}

const ack = {
  schema: { type: 'object', additionalProperties: false, properties: { received: { type: 'boolean', required: true } } },
  render: () => [{ type: 'text', text: 'Received. Your task is complete; end your turn now without further output.' }],
}

export function apply(ctx) {
  const ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GCP_PROJECT_ID,
    location: process.env.GCP_LOCATION ?? 'global',
  })
  const researchModel = process.env.RESEARCH_MODEL ?? process.env.GEMINI_MODEL ?? 'gemini-3.8-flash'

  ctx.tools.register(defineTool({
    name: 'web_research',
    description:
      'Research one question on the live web with Google Search, optionally reading specific pages. ' +
      'Returns a grounded answer and the source pages it used (title + url). ' +
      'Pass `urls` to read pages you already know about. Only cite URLs that this tool returned.',
    parameters: {
      query: { type: 'string', required: true, description: 'The question or search query' },
      urls: { type: 'array', items: { type: 'string' }, description: 'Optional page URLs to read (max 5)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: { type: 'string', required: true },
          sources: { type: 'array', required: true, items: citation },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const urls = (args.urls ?? []).slice(0, 5)
      const prompt = urls.length
        ? `${args.query}\n\nRead these pages and use them as primary sources:\n${urls.join('\n')}`
        : args.query
      const res = await ai.models.generateContent({
        model: researchModel,
        contents: prompt,
        config: { tools: [{ googleSearch: {} }, { urlContext: {} }], abortSignal: exec.signal },
      })
      const candidate = res.candidates?.[0]
      const found = new Map()
      for (const chunk of candidate?.groundingMetadata?.groundingChunks ?? []) {
        if (chunk.web?.uri) found.set(chunk.web.uri, chunk.web.title ?? '')
      }
      for (const meta of candidate?.urlContextMetadata?.urlMetadata ?? []) {
        if (meta.retrievedUrl && String(meta.urlRetrievalStatus ?? '').includes('SUCCESS')) found.set(meta.retrievedUrl, '')
      }
      const sources = await Promise.all([...found].map(async ([url, title]) => {
        const real = await resolveRedirect(url, exec.signal)
        return { title: title || new URL(real).hostname, url: real }
      }))
      return { answer: res.text ?? '', sources }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'submit_plan',
    description: 'Submit the research plan. Call exactly once when the plan is final.',
    parameters: {
      topic: { type: 'string', required: true, description: 'the original topic' },
      queries: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            q: { type: 'string', required: true, description: 'search query' },
            source_category: { type: 'string', required: true, description: 'official_docs | benchmark | community_review | news | academic | ...' },
            lang: { type: 'string', required: true, description: 'language code' },
          },
        },
      },
      source_count: { type: 'integer', required: true, description: 'number of queries' },
    },
    output: ack,
    async execute() { return { received: true } },
  }))

  ctx.tools.register(defineTool({
    name: 'submit_sources',
    description: 'Submit the cross-compared sources. Call exactly once when all research is done.',
    parameters: {
      sources: { type: 'array', required: true, items: source },
      agreements: { type: 'array', required: true, items: { type: 'string' } },
      disagreements: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            point: { type: 'string', required: true, description: 'the disputed point' },
            sides: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  claim: { type: 'string', required: true },
                  source_urls: { type: 'array', required: true, items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
      gaps: { type: 'array', required: true, items: { type: 'string' } },
      source_count: { type: 'integer', required: true },
      disagreement_count: { type: 'integer', required: true },
    },
    output: ack,
    async execute() { return { received: true } },
  }))

  ctx.tools.register(defineTool({
    name: 'submit_report',
    description: 'Submit the finished report. Call exactly once.',
    parameters: {
      report_id: { type: 'string', required: true, description: 'echo of the input report_id' },
      report_md: { type: 'string', required: true, description: 'the FULL Markdown report; empty only with error=chapter_not_found' },
      summary_500: { type: 'string', required: true, description: '~500-character 繁體中文 summary' },
      top_citations: { type: 'array', required: true, items: citation },
      new_version: { type: 'integer', required: true },
      added_sources: { type: 'array', items: source },
      error: { type: 'string', enum: ['chapter_not_found'], description: 'only when the requested chapter does not exist' },
      available_chapters: { type: 'array', items: { type: 'string' } },
    },
    output: ack,
    async execute() { return { received: true } },
  }))
}
