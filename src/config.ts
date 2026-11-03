// Environment configuration.

export interface Config {
  port: number
  gcpProject: string
  gcpLocation: string
  geminiModel: string
  gcsBucket: string
  collectionPrefix: string
  tasksQueue: string
  tasksLocation: string
  serviceURL: string
  serviceAccountEmail: string
  lineChannelSecret: string
  lineChannelAccessToken: string
  litellmBaseURL: string
  litellmApiKey: string
  dshHome: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = []
  const need = (k: string) => {
    const v = env[k]
    if (!v) missing.push(k)
    return v ?? ''
  }
  const cfg: Config = {
    port: Number(env.PORT ?? 8080),
    gcpProject: need('GCP_PROJECT_ID'),
    gcpLocation: env.GCP_LOCATION || 'global',
    geminiModel: env.GEMINI_MODEL || 'gemini-3.8-flash',
    gcsBucket: need('GCS_BUCKET'),
    collectionPrefix: env.FIRESTORE_COLLECTION_PREFIX || 'line_bot_',
    tasksQueue: env.CLOUD_TASKS_QUEUE || 'research-jobs',
    tasksLocation: env.CLOUD_TASKS_LOCATION || 'asia-east1',
    serviceURL: env.CLOUD_RUN_SERVICE_URL ?? '',
    serviceAccountEmail: env.SERVICE_ACCOUNT_EMAIL ?? '',
    lineChannelSecret: need('LINE_CHANNEL_SECRET'),
    lineChannelAccessToken: need('LINE_CHANNEL_ACCESS_TOKEN'),
    litellmBaseURL: env.LITELLM_BASE_URL || 'http://127.0.0.1:4000',
    litellmApiKey: need('LITELLM_MASTER_KEY'),
    dshHome: env.DSH_HOME || '/tmp/dsh-home',
  }
  if (missing.length) throw new Error(`missing required env: ${missing.join(', ')}`)
  return cfg
}
