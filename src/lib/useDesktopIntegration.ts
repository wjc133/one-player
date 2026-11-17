import { useEffect, useRef, useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { AppSettings, CloseBehavior } from '../types'
import { localStore } from './storage'
import {
  completeWindowClose,
  setDesktopCloseBehavior,
  updateDesktopPlayback,
} from './tauri'

interface DesktopIntegrationProps {
  settings: AppSettings
  setSettings: (update: (current: AppSettings) => AppSettings) => void
  track: string | null
  isPlaying: boolean
  playerPageOpen: boolean
  lyric: string
  onToggle: () => void
  onPrevious: () => void
  onNext: () => void
  onSettings: () => void
  onError: (message: string) => void
}

export function useDesktopIntegration(props: DesktopIntegrationProps) {
  const [closeDialogOpen, setCloseDialogOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [windowVisible, setWindowVisible] = useState(!document.hidden)
  const latest = useRef(props)
  latest.current = props

  useEffect(() => {
    const updateVisibility = () => setWindowVisible(!document.hidden)
    document.addEventListener('visibilitychange', updateVisibility)
    return () => document.removeEventListener('visibilitychange', updateVisibility)
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    const cleanups: Array<() => void> = []
    const subscriptions = [
      listen('desktop:close-requested', () => setCloseDialogOpen(true)),
      listen<string>('desktop:action', ({ payload }) => {
        const current = latest.current
        switch (payload) {
          case 'toggle': current.onToggle(); break
          case 'previous': current.onPrevious(); break
          case 'next': current.onNext(); break
          case 'settings': current.onSettings(); break
          case 'toggle-lyrics':
            current.setSettings((settings) => ({
              ...settings,
              menuBarLyrics: !settings.menuBarLyrics,
            }))
            break
        }
      }),
    ]
    for (const subscription of subscriptions) {
      void subscription.then((unlisten) => {
        if (disposed) unlisten()
        else cleanups.push(unlisten)
      }).catch((error) => {
        if (!disposed) latest.current.onError(`菜单栏连接失败：${String(error)}`)
      })
    }
    return () => {
      disposed = true
      for (const cleanup of cleanups) cleanup()
    }
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    void setDesktopCloseBehavior(props.settings.closeBehavior).catch((error) => {
      latest.current.onError(`保存关闭行为失败：${String(error)}`)
    })
  }, [props.settings.closeBehavior])

  useEffect(() => {
    if (!isTauri()) return
    void updateDesktopPlayback({
      track: props.track,
      isPlaying: props.isPlaying,
      playerPageVisible: props.playerPageOpen && windowVisible,
      lyric: props.lyric,
      menuBarLyrics: props.settings.menuBarLyrics,
    }).catch((error) => {
      latest.current.onError(`更新菜单栏失败：${String(error)}`)
    })
  }, [
    props.track,
    props.isPlaying,
    props.playerPageOpen,
    props.lyric,
    props.settings.menuBarLyrics,
    windowVisible,
  ])

  const confirmClose = async (
    behavior: Exclude<CloseBehavior, 'ask'>,
    remember: boolean,
  ) => {
    if (closing) return
    setClosing(true)
    try {
      if (remember) {
        const settings = { ...latest.current.settings, closeBehavior: behavior }
        localStore.setItem('one-player:settings', JSON.stringify(settings))
        latest.current.setSettings((current) => ({ ...current, closeBehavior: behavior }))
        await setDesktopCloseBehavior(behavior)
      }
      await completeWindowClose(behavior)
      setCloseDialogOpen(false)
    } catch (error) {
      latest.current.onError(`关闭窗口失败：${String(error)}`)
    } finally {
      setClosing(false)
    }
  }

  return {
    closeDialogOpen,
    closing,
    cancelClose: () => { if (!closing) setCloseDialogOpen(false) },
    confirmClose,
  }
}
