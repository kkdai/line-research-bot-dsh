// Cloud Logging-friendly JSON lines (severity + message).

type Fields = Record<string, unknown>

function write(severity: string, message: string, fields?: Fields): void {
  if (process.env.VITEST && !process.env.LOG_IN_TESTS) return
  process.stdout.write(JSON.stringify({ severity, message, time: new Date().toISOString(), ...fields }) + '\n')
}

export const log = {
  info: (message: string, fields?: Fields) => write('INFO', message, fields),
  warn: (message: string, fields?: Fields) => write('WARNING', message, fields),
  error: (message: string, fields?: Fields) => write('ERROR', message, fields),
}
