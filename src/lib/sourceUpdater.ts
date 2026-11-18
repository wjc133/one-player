import type {
  CustomSourceInfo,
  HttpRequestPayload,
  HttpResponsePayload,
  SourceCapabilities,
} from '../types'

interface UpdateRuntime {
  initialize: (source: CustomSourceInfo, script: string) => Promise<SourceCapabilities>
  dispose: () => void
}

interface SourceUpdateDependencies<Runtime extends UpdateRuntime> {
  request: (payload: HttpRequestPayload) => Promise<HttpResponsePayload>
  inspect: (id: string, script: string) => Promise<CustomSourceInfo>
  save: (id: string, script: string) => Promise<CustomSourceInfo>
  createRuntime: (source: CustomSourceInfo) => Runtime
  openExternalUrl: (url: string) => Promise<void>
}

export async function updateSourceFromUrl<Runtime extends UpdateRuntime>(
  id: string,
  url: string,
  proxy: string,
  dependencies: SourceUpdateDependencies<Runtime>,
) {
  const parsedUrl = new URL(url)
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('更新地址必须是 HTTP 或 HTTPS 地址')
  }
  const response = await dependencies.request({
    url,
    proxy: proxy.trim() || undefined,
    timeoutMs: 30_000,
  })
  const script = response.bodyText.trimStart()
  const contentType = Object.entries(response.headers ?? {})
    .find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? ''
  if (!script.startsWith('/*') || /text\/html|application\/(?:json|zip|pdf)/i.test(contentType)) {
    await dependencies.openExternalUrl(url)
    return { kind: 'browser' as const }
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`下载音源更新失败：HTTP ${response.statusCode}`)
  }
  const preview = await dependencies.inspect(id, script)
  const runtime = dependencies.createRuntime(preview)
  try {
    const capabilities = await runtime.initialize(preview, script)
    const source = await dependencies.save(id, script)
    return { kind: 'updated' as const, source, runtime, capabilities }
  } catch (error) {
    runtime.dispose()
    throw error
  }
}
