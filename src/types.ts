export type SourceKey = 'kw' | 'kg' | 'tx' | 'wy' | 'mg' | 'local'
export type OnlineSourceKey = Exclude<SourceKey, 'local'>
export type Quality = '128k' | '320k' | 'flac' | 'flac24bit'
export type SourceAction = 'musicUrl' | 'lyric' | 'pic'

export interface TrackQuality {
  type: Quality
  size: string | null
  hash?: string
}

export interface MusicTrack {
  id: string
  name: string
  singer: string
  source: SourceKey
  songmid: string | number
  interval: string | null
  albumName: string
  albumId?: string | number
  img?: string | null
  types: TrackQuality[]
  _types: Partial<Record<Quality, { size: string | null; hash?: string }>>
  typeUrl: Partial<Record<Quality, string>>
  hash?: string
  albumAudioId?: string
  _interval?: number
  strMediaMid?: string
  songId?: number
  albumMid?: string
  copyrightId?: string
  lrcUrl?: string
  mrcUrl?: string
  trcUrl?: string
  filePath?: string
  ext?: string
}

export interface SearchResult {
  list: MusicTrack[]
  allPage: number
  total: number
  limit: number
  source: OnlineSourceKey
}

export interface AlbumSummary {
  id: string
  name: string
  singer: string
  source: OnlineSourceKey
  img: string | null
  publishTime?: string
  songCount?: number
  albumMid?: string
}

export interface AlbumSearchResult {
  list: AlbumSummary[]
  allPage: number
  total: number
  limit: number
  source: OnlineSourceKey
}

export interface AlbumDetail {
  album: AlbumSummary
  list: MusicTrack[]
}

export interface LyricPayload {
  lyric: string
  tlyric?: string | null
  rlyric?: string | null
  lxlyric?: string | null
}

export interface CustomSourceInfo {
  id: string
  name: string
  description: string
  version: string
  author: string
  homepage: string
  allowShowUpdateAlert: boolean
}

export interface LxMusicSourceSummary {
  id: string
  name: string
  description: string
  version: string
  author: string
}

export interface LxMusicSourceStatus {
  installed: boolean
  canImport: boolean
  installPath?: string
  dataPath?: string
  selectedSourceId?: string
  source?: LxMusicSourceSummary
  message: string
}

export interface LxMusicImportResult {
  source: CustomSourceInfo
  alreadyImported: boolean
}

export interface SourceCapability {
  name?: string
  type: 'music'
  actions: SourceAction[]
  qualitys: Quality[]
}

export type SourceCapabilities = Partial<Record<SourceKey, SourceCapability>>

export interface SourceStatus {
  state: 'idle' | 'loading' | 'ready' | 'error'
  message?: string
  capabilities: SourceCapabilities
}

export interface HttpFormDataValue {
  value?: string
  base64?: string
  fileName?: string
  mime?: string
}

export interface HttpRequestPayload {
  url: string
  method?: string
  headers?: Record<string, string>
  bodyText?: string
  bodyBase64?: string
  form?: Record<string, string>
  formData?: Record<string, HttpFormDataValue>
  timeoutMs?: number
  proxy?: string
}

export interface HttpResponsePayload {
  statusCode: number
  statusMessage: string
  headers: Record<string, string>
  bytes: number
  bodyText: string
  rawBase64: string
}

export interface AppSettings {
  theme: 'dark' | 'light' | 'system'
  playQuality: Quality
  downloadDirectory: string
  proxy: string
}

export interface DownloadItem {
  id: string
  track: MusicTrack
  quality: Quality
  status: 'downloading' | 'done' | 'error'
  path?: string
  message?: string
  createdAt: number
}

