import { Buffer } from 'buffer'
import forge from 'node-forge'
import pako from 'pako'
import type {
  CustomSourceInfo,
  HttpFormDataValue,
  HttpRequestPayload,
  HttpResponsePayload,
  Quality,
  SourceAction,
  SourceCapabilities,
  SourceKey,
} from './types'

const CHANNEL = 'one-player-source'
const EVENT_NAMES = {
  request: 'request',
  inited: 'inited',
  updateAlert: 'updateAlert',
} as const
const eventNames = Object.values(EVENT_NAMES)
const supportedSources: SourceKey[] = ['kw', 'kg', 'tx', 'wy', 'mg', 'local']
const supportedQualitys: Record<SourceKey, Quality[]> = {
  kw: ['128k', '320k', 'flac', 'flac24bit'],
  kg: ['128k', '320k', 'flac', 'flac24bit'],
  tx: ['128k', '320k', 'flac', 'flac24bit'],
  wy: ['128k', '320k', 'flac', 'flac24bit'],
  mg: ['128k', '320k', 'flac', 'flac24bit'],
  local: [],
}
const supportedActions: Record<SourceKey, SourceAction[]> = {
  kw: ['musicUrl'],
  kg: ['musicUrl'],
  tx: ['musicUrl'],
  wy: ['musicUrl'],
  mg: ['musicUrl'],
  local: ['musicUrl', 'lyric', 'pic'],
}

type RequestHandler = (payload: {
  source: SourceKey
  action: SourceAction
  info: unknown
}) => Promise<unknown>

interface RuntimeState {
  source?: CustomSourceInfo & { script: string }
  requestHandler?: RequestHandler
  initialized: boolean
  updateAlertSent: boolean
  lastHttpFailure?: {
    statusCode: number
    statusMessage: string
    url: string
    body: string
  }
  requestCallbacks: Map<
    string,
    {
      callback: (error: Error | null, response: unknown, body: unknown) => void
      cancelled: boolean
      url: string
    }
  >
}

const state: RuntimeState = {
  initialized: false,
  updateAlertSent: false,
  requestCallbacks: new Map(),
}

const post = (type: string, payload?: unknown) => {
  globalThis.postMessage({ channel: CHANNEL, type, payload })
}

const normalizeBody = (
  body: unknown,
  headers: Record<string, string>,
): Pick<HttpRequestPayload, 'bodyText' | 'bodyBase64'> => {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return { bodyBase64: Buffer.from(body).toString('base64') }
  }
  if (typeof body === 'string') return { bodyText: body }
  if (body != null) {
    const hasContentType = Object.keys(headers).some(
      (name) => name.toLowerCase() === 'content-type',
    )
    if (!hasContentType) headers['content-type'] = 'application/json'
    return { bodyText: JSON.stringify(body) }
  }
  return {}
}

const normalizeFormData = (value: Record<string, unknown>) => {
  const result: Record<string, HttpFormDataValue> = {}
  for (const [name, rawValue] of Object.entries(value)) {
    if (Buffer.isBuffer(rawValue) || rawValue instanceof Uint8Array) {
      result[name] = { base64: Buffer.from(rawValue).toString('base64') }
      continue
    }
    if (rawValue && typeof rawValue === 'object' && 'value' in rawValue) {
      const item = rawValue as {
        value: unknown
        options?: { filename?: string; contentType?: string }
      }
      if (Buffer.isBuffer(item.value) || item.value instanceof Uint8Array) {
        result[name] = {
          base64: Buffer.from(item.value).toString('base64'),
          fileName: item.options?.filename,
          mime: item.options?.contentType,
        }
      } else {
        result[name] = {
          value: String(item.value ?? ''),
          fileName: item.options?.filename,
          mime: item.options?.contentType,
        }
      }
      continue
    }
    result[name] = { value: String(rawValue ?? '') }
  }
  return result
}

const validateLyrics = (value: unknown) => {
  if (!value || typeof value !== 'object') throw new Error('failed')
  const info = value as Record<string, unknown>
  if (typeof info.lyric !== 'string' || info.lyric.length > 51_200) {
    throw new Error('failed')
  }
  return {
    lyric: info.lyric,
    tlyric:
      typeof info.tlyric === 'string' && info.tlyric.length < 5_120
        ? info.tlyric
        : null,
    rlyric:
      typeof info.rlyric === 'string' && info.rlyric.length < 5_120
        ? info.rlyric
        : null,
    lxlyric:
      typeof info.lxlyric === 'string' && info.lxlyric.length < 8_192
        ? info.lxlyric
        : null,
  }
}

const validateCapabilities = (value: unknown): SourceCapabilities => {
  if (!value || typeof value !== 'object') {
    throw new Error('Missing required parameter init info')
  }
  const info = value as {
    openDevTools?: boolean
    sources?: Partial<
      Record<
        SourceKey,
        {
          name?: string
          type?: string
          actions?: unknown
          qualitys?: unknown
        }
      >
    >
  }
  if (info.openDevTools === true) post('openDevTools')
  const capabilities: SourceCapabilities = {}
  for (const source of supportedSources) {
    const candidate = info.sources?.[source]
    if (!candidate || candidate.type !== 'music') continue
    const actions = Array.isArray(candidate.actions) ? candidate.actions : []
    const qualitys = Array.isArray(candidate.qualitys) ? candidate.qualitys : []
    capabilities[source] = {
      name: typeof candidate.name === 'string' ? candidate.name : undefined,
      type: 'music',
      actions: supportedActions[source].filter((action) =>
        actions.includes(action),
      ),
      qualitys: supportedQualitys[source].filter((quality) =>
        qualitys.includes(quality),
      ),
    }
  }
  return capabilities
}

const createLxApi = () => {
  if (!state.source) throw new Error('Source has not been initialized')
  const source = state.source
  return {
    EVENT_NAMES,
    request(
      url: string,
      options: {
        method?: string
        timeout?: number
        headers?: Record<string, string>
        body?: unknown
        form?: Record<string, unknown>
        formData?: Record<string, unknown>
      } = {},
      callback: (error: Error | null, response: unknown, body: unknown) => void,
    ) {
      const id = crypto.randomUUID()
      const headers = { ...(options.headers ?? {}) }
      const payload: HttpRequestPayload = {
        url,
        method: options.method ?? 'get',
        timeoutMs:
          typeof options.timeout === 'number' && options.timeout > 0
            ? Math.min(options.timeout, 60_000)
            : 60_000,
        headers,
        ...normalizeBody(options.body, headers),
        form: options.form
          ? Object.fromEntries(
              Object.entries(options.form).map(([key, value]) => [
                key,
                String(value ?? ''),
              ]),
            )
          : undefined,
        formData: options.formData
          ? normalizeFormData(options.formData)
          : undefined,
      }
      state.requestCallbacks.set(id, { callback, cancelled: false, url })
      post('httpRequest', { id, payload })
      return () => {
        const request = state.requestCallbacks.get(id)
        if (!request) return
        request.cancelled = true
        state.requestCallbacks.delete(id)
        post('httpCancel', { id })
      }
    },
    send(eventName: string, data: unknown) {
      return new Promise<void>((resolve, reject) => {
        if (!eventNames.includes(eventName as (typeof eventNames)[number])) {
          reject(new Error(`The event is not supported: ${eventName}`))
          return
        }
        if (eventName === EVENT_NAMES.inited) {
          if (state.initialized) {
            reject(new Error('Script is inited'))
            return
          }
          try {
            const capabilities = validateCapabilities(data)
            state.initialized = true
            post('initialized', { capabilities })
            resolve()
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error)
            post('initError', { message })
            reject(error)
          }
          return
        }
        if (eventName === EVENT_NAMES.updateAlert) {
          if (state.updateAlertSent) {
            reject(
              new Error('The update alert can only be called once.'),
            )
            return
          }
          const alert = data as { log?: unknown; updateUrl?: unknown }
          if (!alert || typeof alert !== 'object') {
            reject(new Error('parameter format error.'))
            return
          }
          if (typeof alert.log !== 'string' || !alert.log) {
            reject(new Error('log is required.'))
            return
          }
          state.updateAlertSent = true
          post('updateAlert', {
            log:
              alert.log.length > 1_024
                ? `${alert.log.slice(0, 1_024)}...`
                : alert.log,
            updateUrl:
              typeof alert.updateUrl === 'string' &&
              /^https?:\/\/\S+$/i.test(alert.updateUrl) &&
              alert.updateUrl.length <= 1_024
                ? alert.updateUrl
                : undefined,
          })
          resolve()
          return
        }
        reject(new Error(`Unknown event name: ${eventName}`))
      })
    },
    on(eventName: string, handler: RequestHandler) {
      if (eventName !== EVENT_NAMES.request) {
        return Promise.reject(
          new Error(`The event is not supported: ${eventName}`),
        )
      }
      state.requestHandler = handler
      return Promise.resolve()
    },
    utils: {
      crypto: {
        aesEncrypt(
          value: Uint8Array,
          algorithm: string,
          key: Uint8Array,
          iv: Uint8Array,
        ) {
          const modeName = algorithm.split('-').at(-1)?.toLowerCase()
          const modes: Record<string, string> = {
            cbc: 'AES-CBC',
            ecb: 'AES-ECB',
            cfb: 'AES-CFB',
            ofb: 'AES-OFB',
            ctr: 'AES-CTR',
          }
          const mode = modeName ? modes[modeName] : undefined
          if (!mode) throw new Error(`Unsupported AES mode: ${algorithm}`)
          const cipher = forge.cipher.createCipher(
            mode as forge.cipher.Algorithm,
            Buffer.from(key).toString('binary'),
          )
          cipher.start({
            iv:
              modeName === 'ecb'
                ? undefined
                : Buffer.from(iv).toString('binary'),
          } as forge.cipher.StartOptions)
          cipher.update(
            forge.util.createBuffer(Buffer.from(value).toString('binary')),
          )
          if (!cipher.finish()) throw new Error('AES encryption failed')
          return Buffer.from(cipher.output.getBytes(), 'binary')
        },
        rsaEncrypt(value: Uint8Array, key: string) {
          const buffer = Buffer.from(value)
          if (buffer.length > 128) throw new Error('data too large for key size')
          const padded = Buffer.concat([
            Buffer.alloc(128 - buffer.length),
            buffer,
          ])
          const publicKey = forge.pki.publicKeyFromPem(key)
          return Buffer.from(
            publicKey.encrypt(padded.toString('binary'), 'RAW'),
            'binary',
          )
        },
        randomBytes(size: number) {
          const output = Buffer.alloc(size)
          crypto.getRandomValues(output)
          return output
        },
        md5(value: string) {
          return forge.md.md5
            .create()
            .update(value, 'utf8')
            .digest()
            .toHex()
        },
      },
      buffer: {
        from(...args: Parameters<typeof Buffer.from>) {
          return Buffer.from(...args)
        },
        bufToString(value: Uint8Array, format?: BufferEncoding) {
          return Buffer.from(value).toString(format)
        },
      },
      zlib: {
        inflate(value: Uint8Array) {
          return Promise.resolve(Buffer.from(pako.inflate(value)))
        },
        deflate(value: Uint8Array) {
          return Promise.resolve(Buffer.from(pako.deflate(value)))
        },
      },
    },
    currentScriptInfo: {
      name: source.name,
      description: source.description,
      version: source.version,
      author: source.author,
      homepage: source.homepage,
      rawScript: source.script,
    },
    version: '2.0.0',
    env: 'desktop',
  }
}

const failInitialization = (message: string) => {
  if (state.initialized) return
  state.initialized = true
  const failure = state.lastHttpFailure
  const requestDetail = failure
    ? `（最近请求：HTTP ${failure.statusCode}${
        failure.statusMessage ? ` ${failure.statusMessage}` : ''
      } · ${failure.url}${failure.body ? ` · ${failure.body}` : ''}）`
    : ''
  const detail = `${message}${requestDetail}`
  post('initError', {
    message:
      detail.length > 1_024 ? `${detail.slice(0, 1_024)}...` : detail,
  })
}

self.addEventListener('error', (event) => {
  failInitialization(event.message.replace(/^Uncaught\sError:\s/, ''))
})

self.addEventListener('unhandledrejection', (event) => {
  const message =
    typeof event.reason === 'string'
      ? event.reason
      : (event.reason as Error | undefined)?.message ?? String(event.reason)
  failInitialization(message.replace(/^Error:\s/, ''))
})

self.addEventListener('message', (event) => {
  const message = event.data as {
    channel?: string
    type?: string
    payload?: Record<string, unknown>
  }
  if (message.channel !== CHANNEL || !message.type) return

  if (message.type === 'init') {
    const source = message.payload?.source as CustomSourceInfo & {
      script: string
    }
    state.source = source
    Object.defineProperty(globalThis, 'window', {
      value: globalThis,
      configurable: false,
      writable: false,
    })
    Object.defineProperty(globalThis, 'lx', {
      value: createLxApi(),
      configurable: false,
      writable: false,
    })
    try {
      const execute = new Function(source.script)
      execute.call(globalThis)
    } catch (error) {
      failInitialization(
        error instanceof Error ? error.message : String(error),
      )
    }
    return
  }

  if (message.type === 'httpResponse') {
    const id = String(message.payload?.id ?? '')
    const pending = state.requestCallbacks.get(id)
    if (!pending) return
    state.requestCallbacks.delete(id)
    if (pending.cancelled) return
    const error = message.payload?.error
    if (error) {
      pending.callback(new Error(String(error)), null, null)
      return
    }
    const response = message.payload?.response as HttpResponsePayload
    if (response.statusCode < 200 || response.statusCode >= 300) {
      let requestUrl = pending.url
      try {
        const parsed = new URL(requestUrl)
        requestUrl = `${parsed.origin}${parsed.pathname}`
      } catch {
        requestUrl = requestUrl.split('?')[0]
      }
      state.lastHttpFailure = {
        statusCode: response.statusCode,
        statusMessage: response.statusMessage,
        url: requestUrl.slice(0, 240),
        body: response.bodyText.replace(/\s+/g, ' ').trim().slice(0, 240),
      }
    }
    const raw = Buffer.from(response.rawBase64, 'base64')
    let body: unknown = response.bodyText
    try {
      body = JSON.parse(response.bodyText)
    } catch {
      // Preserve the text response.
    }
    pending.callback(
      null,
      {
        statusCode: response.statusCode,
        statusMessage: response.statusMessage,
        headers: response.headers,
        bytes: response.bytes,
        raw,
        body,
      },
      body,
    )
    return
  }

  if (message.type === 'request') {
    const requestId = String(message.payload?.requestId ?? '')
    const data = message.payload?.data as {
      source: SourceKey
      action: SourceAction
      info: { type?: Quality }
    }
    if (!state.requestHandler) {
      post('sourceResponse', {
        requestId,
        error: 'Request event is not defined',
      })
      return
    }
    try {
      const promise = state.requestHandler({
        source: data.source,
        action: data.action,
        info: data.info,
      })
      if (!promise || typeof promise.then !== 'function') {
        throw new Error('Request handler must return a Promise')
      }
      promise
        .then((value) => {
          let result: unknown
          if (data.action === 'musicUrl') {
            if (
              typeof value !== 'string' ||
              value.length > 2_048 ||
              !/^https?:/i.test(value)
            ) {
              throw new Error('failed')
            }
            result = {
              source: data.source,
              action: data.action,
              data: { type: data.info.type, url: value },
            }
          } else if (data.action === 'lyric') {
            result = {
              source: data.source,
              action: data.action,
              data: validateLyrics(value),
            }
          } else if (data.action === 'pic') {
            if (
              typeof value !== 'string' ||
              value.length > 2_048 ||
              !/^https?:/i.test(value)
            ) {
              throw new Error('failed')
            }
            result = {
              source: data.source,
              action: data.action,
              data: value,
            }
          }
          post('sourceResponse', { requestId, result })
        })
        .catch((error) => {
          post('sourceResponse', {
            requestId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
    } catch (error) {
      post('sourceResponse', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
})

post('ready')

