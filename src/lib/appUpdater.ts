export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'installed'
  | 'restarting'

type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' }

interface UpdatePackage {
  version: string
  body?: string
  date?: string
  download: (onEvent: (event: DownloadEvent) => void, options: { timeout: number }) => Promise<void>
  install: () => Promise<void>
  close: () => Promise<void>
}

interface UpdaterDependencies {
  check: (options: { proxy?: string; timeout: number }) => Promise<UpdatePackage | null>
  relaunch: () => Promise<void>
}

export interface AppUpdateState {
  phase: UpdatePhase
  release: { version: string; notes: string; date?: string } | null
  receivedBytes: number
  totalBytes: number | null
  error: string
  checkedAt: number | null
}

export function createAppUpdater(dependencies: UpdaterDependencies) {
  let update: UpdatePackage | null = null
  let state: AppUpdateState = {
    phase: 'idle',
    release: null,
    receivedBytes: 0,
    totalBytes: null,
    error: '',
    checkedAt: null,
  }
  const listeners = new Set<() => void>()
  const publish = (changes: Partial<AppUpdateState>) => {
    state = { ...state, ...changes }
    for (const listener of listeners) listener()
  }
  const releaseUpdate = async () => {
    const previous = update
    update = null
    await previous?.close().catch(() => {})
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async check(proxy: string) {
      if (!['idle', 'current', 'available'].includes(state.phase)) return
      const previousPhase = state.phase
      publish({ phase: 'checking', error: '' })
      try {
        const next = await dependencies.check({
          proxy: proxy.trim() || undefined,
          timeout: 20_000,
        })
        await releaseUpdate()
        update = next
        publish({
          phase: next ? 'available' : 'current',
          release: next
            ? { version: next.version, notes: next.body || '', date: next.date }
            : null,
          receivedBytes: 0,
          totalBytes: null,
          checkedAt: Date.now(),
        })
      } catch {
        publish({
          phase: previousPhase,
          error: '无法获取更新信息，请检查网络或 HTTP 代理后重试。',
        })
      }
    },
    async download() {
      if (!update || state.phase !== 'available') return
      publish({ phase: 'downloading', receivedBytes: 0, totalBytes: null, error: '' })
      try {
        await update.download((event) => {
          if (event.event === 'Started') {
            publish({ totalBytes: event.data.contentLength || null })
          } else if (event.event === 'Progress') {
            publish({ receivedBytes: state.receivedBytes + event.data.chunkLength })
          }
        }, { timeout: 10 * 60_000 })
        publish({ phase: 'ready' })
      } catch {
        publish({
          phase: 'available',
          error: '更新包下载或校验失败，请检查网络后重试。',
        })
      }
    },
    async install() {
      if (!update || state.phase !== 'ready') return
      publish({ phase: 'installing', error: '' })
      try {
        await update.install()
      } catch {
        publish({
          phase: 'available',
          error: '安装更新失败，请重新下载后重试，并确认应用所在目录可写。',
          receivedBytes: 0,
          totalBytes: null,
        })
        return
      }
      await releaseUpdate()
      publish({ phase: 'installed' })
      await this.restart()
    },
    async restart() {
      if (state.phase !== 'installed') return
      publish({ phase: 'restarting', error: '' })
      try {
        await dependencies.relaunch()
      } catch {
        publish({
          phase: 'installed',
          error: '更新已安装。自动重启失败，请重试或退出后重新打开 One Player。',
        })
      }
    },
  }
}

export type AppUpdater = ReturnType<typeof createAppUpdater>
