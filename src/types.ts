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
  isLocalLibrary?: boolean
  downloadKey?: string
}

export interface LocalMusicMetadata {
  path: string
  title: string
  artist: string
  album: string
  durationSeconds: number
  coverDataUrl?: string
  trackKey?: string
  extension: string
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

export interface SavedAlbum {
  album: AlbumSummary
  tracks: MusicTrack[]
  savedAt: number
  coverDataUrl?: string
}

export interface LyricPayload {
  lyric: string
  tlyric?: string | null
  rlyric?: string | null
  lxlyric?: string | null
}

export interface PlayList {
  id: string
  name: string
  tracks: MusicTrack[]
  createdAt: number
  coverUrl?: string | null
  importSource?: {
    platform: OnlineSourceKey
    playlistId: string
    importedAt: number
  }
}

export interface PlaylistImportPlatform {
  source: OnlineSourceKey
  name: string
  installed: boolean
  canImport: boolean
  message: string
}

export interface ImportPlaylistSummary {
  id: string
  name: string
  coverUrl: string | null
  trackCount: number
  kind: 'created' | 'subscribed'
}

export interface ImportPlaylistCatalog {
  accountName: string
  playlists: ImportPlaylistSummary[]
}

export interface ImportedPlaylist {
  externalId: string
  name: string
  coverUrl: string | null
  tracks: MusicTrack[]
}

export interface PlaylistImportResult {
  playlists: ImportedPlaylist[]
  failures: Array<{ id: string; name: string; message: string }>
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
  downloadAlbumsOnFavorite: boolean
  overwriteExistingTags: boolean
  autoCheckUpdates: boolean
  proxy: string
}

export type AudioDownloadFormat = 'mp3' | 'flac' | 'wav' | 'ape' | 'dsf' | 'm4a' | 'aac' | 'ogg' | 'opus' | 'aiff' | 'wv'

export interface WalkmanDevice {
  id: string
  name: string
  musicDirectory: string
  totalBytes: number
  freeBytes: number
}

export interface WalkmanTrack {
  path: string
  relativePath: string
  title: string
  artist: string
  album: string
  format: string
  size: number
  missingFields: string[]
  inferredFields: string[]
  hasCover: boolean
  modifiedAt: number
  tagError?: string | null
}

export interface WalkmanLibrary {
  files: WalkmanTrack[]
  issues: string[]
}

export interface DownloadMetadata {
  importSource?: string
  title: string
  artist: string
  album: string
  coverUrl?: string
  trackKey?: string
}

export interface DownloadedAudio {
  importSource?: string | null
  path: string
  title: string
  artist: string
  album: string
  format: AudioDownloadFormat
  size: number
  modifiedAt: number
  coverDataUrl?: string
  trackKey?: string
}

export interface DownloadProgress {
  taskId: string
  progress: number | null
  receivedBytes: number
  totalBytes: number | null
}

export interface DownloadTask {
  id: string
  trackKey: string
  track: MusicTrack
  quality: Quality
  status: 'downloading' | 'error'
  progress: number | null
  receivedBytes: number
  totalBytes: number | null
  message?: string
  createdAt: number
  destination?: string
}

export interface LegacyDownloadItem {
  id: string
  track: MusicTrack
  quality: Quality
  status: 'downloading' | 'done' | 'error'
  path?: string
  message?: string
  createdAt: number
}

