import type {
  CustomSourceInfo,
  HttpRequestPayload,
  SourceCapabilities,
  SourceKey,
  SourceAction,
} from '../types'
import { requestHttp } from './tauri'

const CHANNEL = 'one-player-source'

interface RuntimeOptions {
  getProxy: () => string
  onUpdateAlert: (alert: { log: string; updateUrl?: string }) => void
  onOpenDevTools?: () => void
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: number
}

export class SourceRuntime {
  private worker: Worker
  private readyPromise: Promise<void>
  private resolveReady!: () => void
  private initPromise?: Promise<SourceCapabilities>
  private resolveInit?: (capabilities: SourceCapabilities) => void
  private rejectInit?: (error: Error) => void
  private pending = new Map<string, PendingRequest>()
  private disposed = false
  private options: RuntimeOptions

  constructor(options: RuntimeOptions) {
    this.options = options
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve
    })
    this.worker = new Worker(new URL('../source-runtime.ts', import.meta.url), {
      type: 'module',
      name: 'lx-custom-source',
    })
    this.worker.addEventListener('message', this.handleMessage)
    this.worker.addEventListener('error', this.handleWorkerError)
  }

  async initialize(
    source: CustomSourceInfo,
    script: string,
  ): Promise<SourceCapabilities> {
    await this.readyPromise
    if (this.disposed) throw new Error('自定义源运行时已销毁')
    this.initPromise = new Promise<SourceCapabilities>((resolve, reject) => {
      this.resolveInit = resolve
      this.rejectInit = reject
      window.setTimeout(() => {
        reject(new Error('自定义源初始化超时'))
      }, 15_000)
    })
    this.post('init', { source: { ...source, script } })
    return this.initPromise
  }

  request(data: {
    source: SourceKey
    action: SourceAction
    info: unknown
  }): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('自定义源运行时已销毁'))
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('自定义源请求超时'))
      }, 20_000)
      this.pending.set(requestId, { resolve, reject, timeout })
      this.post('request', { requestId, data })
    })
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.worker.removeEventListener('message', this.handleMessage)
    this.worker.removeEventListener('error', this.handleWorkerError)
    this.worker.terminate()
    this.rejectInit?.(new Error('自定义源运行时已销毁'))
    for (const request of this.pending.values()) {
      window.clearTimeout(request.timeout)
      request.reject(new Error('自定义源运行时已销毁'))
    }
    this.pending.clear()
  }

  private post(type: string, payload?: unknown) {
    this.worker.postMessage({ channel: CHANNEL, type, payload })
  }

  private handleMessage = (event: MessageEvent) => {
    const message = event.data as {
      channel?: string
      type?: string
      payload?: Record<string, unknown>
    }
    if (message.channel !== CHANNEL || !message.type) return

    if (message.type === 'ready') {
      this.resolveReady()
      return
    }
    if (message.type === 'initialized') {
      this.resolveInit?.(
        message.payload?.capabilities as SourceCapabilities,
      )
      return
    }
    if (message.type === 'initError') {
      this.rejectInit?.(
        new Error(String(message.payload?.message ?? '自定义源初始化失败')),
      )
      return
    }
    if (message.type === 'sourceResponse') {
      const requestId = String(message.payload?.requestId ?? '')
      const pending = this.pending.get(requestId)
      if (!pending) return
      this.pending.delete(requestId)
      window.clearTimeout(pending.timeout)
      if (message.payload?.error) {
        pending.reject(new Error(String(message.payload.error)))
      } else {
        pending.resolve(message.payload?.result)
      }
      return
    }
    if (message.type === 'httpRequest') {
      const id = String(message.payload?.id ?? '')
      const payload = message.payload?.payload as HttpRequestPayload
      void requestHttp({
        ...payload,
        proxy: this.options.getProxy() || undefined,
      })
        .then((response) => {
          this.post('httpResponse', { id, response })
        })
        .catch((error) => {
          this.post('httpResponse', {
            id,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      return
    }
    if (message.type === 'updateAlert') {
      this.options.onUpdateAlert(
        message.payload as { log: string; updateUrl?: string },
      )
      return
    }
    if (message.type === 'openDevTools') {
      this.options.onOpenDevTools?.()
    }
  }

  private handleWorkerError = (event: ErrorEvent) => {
    const error = new Error(event.message || '自定义源运行时异常')
    this.rejectInit?.(error)
    for (const request of this.pending.values()) {
      window.clearTimeout(request.timeout)
      request.reject(error)
    }
    this.pending.clear()
  }
}

