import { useEffect, useRef, useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import type { AppSettings, CloseBehavior } from '../types'
import { localStore } from './storage'
import {
  completeWindowClose,
  setDesktopCloseBehavior,
  setDesktopTrayVisible,
  updateDesktopPlayback,
} from './tauri'

interface DesktopIntegrationProps {
  settings: AppSettings
  setSettings: (update: (current: AppSettings) => AppSettings) => void
  track: string | null
  isPlaying: boolean
  canToggle: boolean
  canPrevious: boolean
  canNext: boolean
  playerPageOpen: boolean
  lyric: string
  onToggle: () => void
  onSetPlaying: (playing: boolean) => void
  onPrevious: () => void
  onNext: () => void
  onSeek: (position: number) => void
  onSettings: () => void
  onError: (message: string) => void
}

export function useDesktopIntegration(props: DesktopIntegrationProps) {
  const [closeDialogOpen, setCloseDialogOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [windowVisible, setWindowVisible] = useState(!document.hidden)
  const [menuConnected, setMenuConnected] = useState(false)
  const latest = useRef(props)
  latest.current = props
  const hasTrack = props.track !== null

  useEffect(() => {
    const session = navigator.mediaSession
    if (!session || !hasTrack) return

    const actions: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ['play', () => latest.current.onSetPlaying(true)],
      ['pause', () => latest.current.onSetPlaying(false)],
      ['seekto', ({ seekTime }) => {
        if (seekTime !== undefined) latest.current.onSeek(seekTime)
      }],
    ]
    if (props.canPrevious) actions.push(['previoustrack', () => latest.current.onPrevious()])
    if (props.canNext) actions.push(['nexttrack', () => latest.current.onNext()])

    const registered: MediaSessionAction[] = []
    for (const [action, handler] of actions) {
      try {
        session.setActionHandler(action, handler)
        registered.push(action)
      } catch (error) {
        console.debug(`无法注册系统媒体操作 ${action}`, error)
      }
    }
    return () => {
      for (const action of registered) session.setActionHandler(action, null)
    }
  }, [hasTrack, props.canPrevious, props.canNext])

  useEffect(() => {
    const updateVisibility = () => setWindowVisible(!document.hidden)
    document.addEventListener('visibilitychange', updateVisibility)
    return () => document.removeEventListener('visibilitychange', updateVisibility)
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    const cleanups: Array<() => void> = []
    const window = getCurrentWebviewWindow()
    const subscriptions = [
      window.listen('desktop:close-requested', () => setCloseDialogOpen(true)),
      window.listen<string>('desktop:action', ({ payload }) => {
        const current = latest.current
        switch (payload) {
          case 'toggle': current.onToggle(); break
          case 'previous': current.onPrevious(); break
          case 'next': current.onNext(); break
          case 'settings': current.onSettings(); break
          case 'toggle-lyrics':
            if (!current.settings.showMenuBarIcon) break
            current.setSettings((settings) => ({
              ...settings,
              menuBarLyrics: !settings.menuBarLyrics,
            }))
            break
        }
      }),
    ]
    void Promise.all(subscriptions.map((subscription) =>
      subscription.then((unlisten) => {
        if (disposed) unlisten()
        else cleanups.push(unlisten)
      })
    )).then(() => {
      if (!disposed) setMenuConnected(true)
    }).catch((error) => {
      if (!disposed) latest.current.onError(`菜单栏连接失败：${String(error)}`)
    })
    return () => {
      disposed = true
      for (const cleanup of cleanups) cleanup()
    }
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    void setDesktopTrayVisible(props.settings.showMenuBarIcon).catch((error) => {
      latest.current.onError(`更新菜单栏图标失败：${String(error)}`)
    })
  }, [props.settings.showMenuBarIcon])

  useEffect(() => {
    if (!isTauri()) return
    void setDesktopCloseBehavior(props.settings.closeBehavior).catch((error) => {
      latest.current.onError(`保存关闭行为失败：${String(error)}`)
    })
  }, [props.settings.closeBehavior])

  useEffect(() => {
    if (!menuConnected) return
    void updateDesktopPlayback({
      track: props.track,
      isPlaying: props.isPlaying,
      canToggle: props.canToggle,
      canPrevious: props.canPrevious,
      canNext: props.canNext,
      playerPageVisible: props.playerPageOpen && windowVisible,
      lyric: props.lyric,
      menuBarLyrics: props.settings.showMenuBarIcon && props.settings.menuBarLyrics,
    }).catch((error) => {
      latest.current.onError(`更新菜单栏失败：${String(error)}`)
    })
  }, [
    menuConnected,
    props.track,
    props.isPlaying,
    props.canToggle,
    props.canPrevious,
    props.canNext,
    props.playerPageOpen,
    props.lyric,
    props.settings.menuBarLyrics,
    props.settings.showMenuBarIcon,
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
