import { invoke } from '@tauri-apps/api/core'
import type {
  DownloadedAudio,
  DownloadMetadata,
  CustomSourceInfo,
  HttpRequestPayload,
  HttpResponsePayload,
  LocalMusicMetadata,
  LxMusicImportResult,
  LxMusicSourceStatus,
  WalkmanDevice,
  WalkmanLibrary,
  WalkmanTrack,
} from '../types'

export const listCustomSources = () =>
  invoke<CustomSourceInfo[]>('list_custom_sources')

export const getCustomSourceScript = (id: string) =>
  invoke<string>('get_custom_source_script', { id })

export const importCustomSourceScript = (script: string) =>
  invoke<CustomSourceInfo>('import_custom_source_script', { script })

export const importCustomSourceFile = (path: string) =>
  invoke<CustomSourceInfo>('import_custom_source_file', { path })

export const removeCustomSource = (id: string) =>
  invoke<CustomSourceInfo[]>('remove_custom_source', { id })

export const setCustomSourceUpdateAlert = (id: string, enabled: boolean) =>
  invoke<void>('set_custom_source_update_alert', { id, enabled })

export const detectLxMusicSource = () =>
  invoke<LxMusicSourceStatus>('detect_lx_music_source')

export const importLxMusicDefaultSource = () =>
  invoke<LxMusicImportResult>('import_lx_music_default_source')

export const requestHttp = (payload: HttpRequestPayload) =>
  invoke<HttpResponsePayload>('proxy_http_request', { payload })

export interface DownloadPayload {
  taskId: string
  url: string
  directory?: string
  fileName: string
  proxy?: string
  metadata: DownloadMetadata
  walkmanId?: string
}

export const downloadFile = (payload: DownloadPayload) =>
  invoke<DownloadedAudio>('download_file', { payload })

export interface DownloadClaimPayload {
  path: string
  metadata: DownloadMetadata
  proxy?: string
}

export const claimDownloadFile = (payload: DownloadClaimPayload) =>
  invoke<string>('claim_download_file', { payload })

export const listDownloads = (directory?: string) =>
  invoke<DownloadedAudio[]>('list_downloads', { directory })

export const getDownloadFileUrl = (path: string, directory?: string) =>
  invoke<string>('get_download_file_url', { path, directory })

export const getLocalMusicFileUrl = (path: string) =>
  invoke<string>('get_local_music_file_url', { path })

export const inspectLocalMusicFiles = (paths: string[]) =>
  invoke<LocalMusicMetadata[]>('inspect_local_music_files', { paths })

export const deleteDownload = (path: string, directory?: string) =>
  invoke<void>('delete_download', { path, directory })

export const detectWalkman = () => invoke<WalkmanDevice[]>('detect_walkman')

export const listWalkmanMusic = (deviceId: string) =>
  invoke<WalkmanLibrary>('list_walkman_music', { deviceId })

export const getWalkmanArtwork = (deviceId: string, path: string) =>
  invoke<string | null>('get_walkman_artwork', { deviceId, path })

export const transferWalkmanFile = (deviceId: string, path: string, toWalkman: boolean, directory?: string) =>
  invoke<string>('transfer_walkman_file', { deviceId, path, toWalkman, directory })

export const updateWalkmanTags = (deviceId: string, path: string, metadata: DownloadMetadata, proxy?: string) =>
  invoke<WalkmanTrack>('update_walkman_tags', { deviceId, path, metadata, proxy })

export const deleteWalkmanFile = (deviceId: string, path: string) =>
  invoke<void>('delete_walkman_file', { deviceId, path })

