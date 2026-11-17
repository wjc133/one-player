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
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`下载音源更新失败：HTTP ${response.statusCode}`)
  }
  const script = response.bodyText.trimStart()
  if (!script.startsWith('/*')) {
    throw new Error('更新地址未返回音源脚本，请复制更新地址获取 .js 文件后本地导入')
  }
  const preview = await dependencies.inspect(id, script)
  const runtime = dependencies.createRuntime(preview)
  try {
    const capabilities = await runtime.initialize(preview, script)
    const source = await dependencies.save(id, script)
    return { source, runtime, capabilities }
  } catch (error) {
    runtime.dispose()
    throw error
  }
}
