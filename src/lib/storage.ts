type LocalStorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function createSafeStorage(
  getStorage: () => LocalStorageAccess,
  onError: (error: unknown) => void = () => {},
) {
  const pending = new Map<string, string | null>()
  const unreadable = new Set<string>()

  return {
    getItem(key: string): string | null {
      if (pending.has(key)) return pending.get(key) ?? null
      try {
        const value = getStorage().getItem(key)
        unreadable.delete(key)
        return value
      } catch (error) {
        unreadable.add(key)
        onError(error)
        return null
      }
    },
    setItem(key: string, value: string) {
      if (unreadable.has(key)) {
        pending.set(key, value)
        return
      }
      try {
        getStorage().setItem(key, value)
        pending.delete(key)
      } catch (error) {
        pending.set(key, value)
        onError(error)
      }
    },
    removeItem(key: string) {
      if (unreadable.has(key)) {
        pending.set(key, null)
        return
      }
      try {
        getStorage().removeItem(key)
        pending.delete(key)
      } catch (error) {
        pending.set(key, null)
        onError(error)
      }
    },
  }
}

let storageWarning = ''
const listeners = new Set<() => void>()

export const localStore = createSafeStorage(() => window.localStorage, (error) => {
  if (storageWarning) return
  storageWarning = '本地设置存储不可用，当前会话可继续，部分设置可能无法在重启后保留。'
  console.warn(storageWarning, error)
  for (const listener of listeners) listener()
})

export const getStorageWarning = () => storageWarning

export function subscribeStorageWarning(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
