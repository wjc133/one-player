import { getVersion } from '@tauri-apps/api/app'
import { isTauri } from '@tauri-apps/api/core'
import { relaunch } from '@tauri-apps/plugin-process'
import { check } from '@tauri-apps/plugin-updater'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AppSettings } from '../types'
import { createAppUpdater } from './appUpdater'

export function useAppUpdater(settings: AppSettings) {
  const [updater] = useState(() => createAppUpdater({ check, relaunch }))
  const state = useSyncExternalStore(updater.subscribe, updater.getSnapshot)
  const [currentVersion, setCurrentVersion] = useState('')
  const proxyRef = useRef(settings.proxy)
  proxyRef.current = settings.proxy
  const supported = isTauri()

  useEffect(() => {
    if (!supported) return
    let active = true
    void getVersion().then((version) => {
      if (active) setCurrentVersion(version)
    }).catch(() => {})
    return () => { active = false }
  }, [supported])

  useEffect(() => {
    if (!supported || !import.meta.env.PROD || !settings.autoCheckUpdates) return
    const runCheck = () => { void updater.check(proxyRef.current) }
    const startup = window.setTimeout(runCheck, 8_000)
    const periodic = window.setInterval(runCheck, 6 * 60 * 60 * 1000)
    return () => {
      window.clearTimeout(startup)
      window.clearInterval(periodic)
    }
  }, [supported, settings.autoCheckUpdates, updater])

  return { updater, state, currentVersion, supported }
}
