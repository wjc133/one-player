import { getCachedCover } from './tauri'

const resolved = new Map<string, string>()
const pending = new Map<string, Promise<string>>()

export function isRemoteCover(url: string) {
  return /^https?:\/\//i.test(url)
}

export function peekCover(url?: string | null) {
  if (!url) return null
  return isRemoteCover(url) ? resolved.get(url) ?? null : url
}

export function forgetCover(url: string) {
  resolved.delete(url)
}

export function resolveCoverUrl(url: string, proxy = ''): Promise<string> {
  const existing = peekCover(url)
  if (existing) return Promise.resolve(existing)
  const key = JSON.stringify([url, proxy])
  const current = pending.get(key)
  if (current) return current
  const request = getCachedCover(url, proxy || undefined)
    .then((localUrl) => {
      if (!localUrl) throw new Error('封面缓存地址为空')
      resolved.set(url, localUrl)
      if (resolved.size > 2048) resolved.delete(resolved.keys().next().value!)
      return localUrl
    })
    .finally(() => pending.delete(key))
  pending.set(key, request)
  return request
}

export function createCoverSession(proxy = '') {
  const requests = new Map<string, Promise<string>>()
  return {
    load(url: string) {
      const existing = peekCover(url)
      if (existing) return Promise.resolve(existing)
      let request = requests.get(url)
      if (!request) {
        request = resolveCoverUrl(url, proxy)
        requests.set(url, request)
      }
      return request
    },
  }
}
