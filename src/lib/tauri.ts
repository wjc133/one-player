import { invoke } from '@tauri-apps/api/core'
import type {
  CustomSourceInfo,
  HttpRequestPayload,
  HttpResponsePayload,
  LxMusicImportResult,
  LxMusicSourceStatus,
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
  url: string
  directory?: string
  fileName: string
  proxy?: string
}

export const downloadFile = (payload: DownloadPayload) =>
  invoke<string>('download_file', { payload })

