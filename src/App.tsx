import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Download,
  FolderOpen,
  Heart,
  Home,
  Library,
  ListMusic,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Minus,
  MoreHorizontal,
  Music2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SkipBack,
  SkipForward,
  Trash2,
  Upload,
  Volume2,
  X,
} from 'lucide-react'
import {
  type CSSProperties,
  type FormEvent,
  type MouseEvent,
  type UIEvent,
  type WheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type {
  AlbumDetail,
  AlbumSummary,
  AppSettings,
  CustomSourceInfo,
  DownloadItem,
  LxMusicSourceStatus,
  LyricPayload,
  MusicTrack,
  OnlineSourceKey,
  Quality,
  SourceCapabilities,
  SourceStatus,
} from './types'
import {
  getAlbumDetail,
  getBuiltinArtwork,
  getBuiltinLyrics,
  providerNames,
  searchAlbums,
  searchMusic,
} from './lib/providers'
import { SourceRuntime } from './lib/sourceRuntime'
import {
  detectLxMusicSource,
  downloadFile,
  getCustomSourceScript,
  importCustomSourceFile,
  importCustomSourceScript,
  importLxMusicDefaultSource,
  listCustomSources,
  removeCustomSource,
  requestHttp,
  setCustomSourceUpdateAlert,
} from './lib/tauri'

type View = 'search' | 'library' | 'downloads' | 'settings'
type SearchMode = 'track' | 'album'

interface LyricLine {
  time: number
  text: string
  translation?: string
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  playQuality: '320k',
  downloadDirectory: '',
  proxy: '',
}

const qualityNames: Record<Quality, string> = {
  '128k': '标准',
  '320k': '高品',
  flac: '无损',
  flac24bit: 'Hi-Res',
}

const qualityOrder: Quality[] = ['128k', '320k', 'flac', 'flac24bit']

const loadJson = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

const formatClock = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const minutes = Math.floor(seconds / 60)
  const rest = Math.floor(seconds % 60)
  return `${minutes.toString().padStart(2, '0')}:${rest
    .toString()
    .padStart(2, '0')}`
}

const sanitizeFileName = (value: string) =>
  value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()

const parseLrc = (lyrics: LyricPayload | null): LyricLine[] => {
  if (!lyrics?.lyric) return []
  const translation = new Map<string, string>()
  for (const rawLine of (lyrics.tlyric ?? '').split(/\r?\n/)) {
    const matches = [...rawLine.matchAll(/\[(\d{1,3}):(\d{1,2}(?:\.\d+)?)\]/g)]
    if (!matches.length) continue
    const text = rawLine.replace(/\[[^\]]+]/g, '').trim()
    for (const match of matches) {
      translation.set(
        `${Number(match[1])}:${Number(match[2]).toFixed(3)}`,
        text,
      )
    }
  }
  const result: LyricLine[] = []
  for (const rawLine of lyrics.lyric.split(/\r?\n/)) {
    const matches = [...rawLine.matchAll(/\[(\d{1,3}):(\d{1,2}(?:\.\d+)?)\]/g)]
    if (!matches.length) continue
    const text = rawLine.replace(/\[[^\]]+]/g, '').trim()
    for (const match of matches) {
      const minutes = Number(match[1])
      const seconds = Number(match[2])
      result.push({
        time: minutes * 60 + seconds,
        text: text || '♪',
        translation: translation.get(`${minutes}:${seconds.toFixed(3)}`),
      })
    }
  }
  return result.sort((left, right) => left.time - right.time)
}

const pickQuality = (
  track: MusicTrack,
  capabilities: SourceCapabilities,
  preferred: Quality,
) => {
  const supported = capabilities[track.source]?.qualitys ?? []
  const available = track.types.map((quality) => quality.type)
  const candidates = supported.filter(
    (quality) => !available.length || available.includes(quality),
  )
  if (candidates.includes(preferred)) return preferred
  const preferredIndex = qualityOrder.indexOf(preferred)
  const lowerOrEqual = [...qualityOrder]
    .slice(0, preferredIndex + 1)
    .reverse()
    .find((quality) => candidates.includes(quality))
  return lowerOrEqual ?? candidates[0] ?? supported[0] ?? preferred
}

const hasPlaybackQuality = (
  track: MusicTrack,
  capabilities: SourceCapabilities,
) =>
  (capabilities[track.source]?.qualitys ?? []).some(
    (quality) =>
      !track.types.length ||
      track.types.some((available) => available.type === quality),
  )

function App() {
  const [view, setView] = useState<View>('search')
  const [settings, setSettings] = useState<AppSettings>(() =>
    loadJson('one-player:settings', DEFAULT_SETTINGS),
  )
  const settingsRef = useRef(settings)
  const [sources, setSources] = useState<CustomSourceInfo[]>([])
  const [activeSourceId, setActiveSourceId] = useState(
    () => localStorage.getItem('one-player:active-source') ?? '',
  )
  const [sourceStatus, setSourceStatus] = useState<SourceStatus>({
    state: 'idle',
    capabilities: {},
  })
  const runtimeRef = useRef<SourceRuntime | null>(null)
  const sourceActivationRef = useRef(0)

  const [provider, setProvider] = useState<OnlineSourceKey>('kw')
  const [searchMode, setSearchMode] = useState<SearchMode>('track')
  const [query, setQuery] = useState('')
  const [searchedQuery, setSearchedQuery] = useState('')
  const [page, setPage] = useState(1)
  const [allPage, setAllPage] = useState(1)
  const [searchResults, setSearchResults] = useState<MusicTrack[]>([])
  const [albumResults, setAlbumResults] = useState<AlbumSummary[]>([])
  const [albumDetail, setAlbumDetail] = useState<AlbumDetail | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const searchRequestRef = useRef(0)
  const [searchHeroExpanded, setSearchHeroExpanded] = useState(true)

  const [favorites, setFavorites] = useState<MusicTrack[]>(() =>
    loadJson('one-player:favorites', []),
  )
  const [downloads, setDownloads] = useState<DownloadItem[]>(() =>
    loadJson('one-player:downloads', []),
  )
  const [queue, setQueue] = useState<MusicTrack[]>([])
  const [currentTrack, setCurrentTrack] = useState<MusicTrack | null>(null)
  const [currentQuality, setCurrentQuality] = useState<Quality>('320k')
  const [audioUrl, setAudioUrl] = useState('')
  const [isResolving, setIsResolving] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(0.8)
  const [artwork, setArtwork] = useState<string | null>(null)
  const [lyrics, setLyrics] = useState<LyricPayload | null>(null)
  const [lyricsLoading, setLyricsLoading] = useState(false)
  const [lyricsError, setLyricsError] = useState('')
  const lyricRequestRef = useRef(0)
  const [playerOpen, setPlayerOpen] = useState(false)

  useEffect(() => {
    document.documentElement.classList.toggle('player-page-open', playerOpen)
    document.body.classList.toggle('player-page-open', playerOpen)

    return () => {
      document.documentElement.classList.remove('player-page-open')
      document.body.classList.remove('player-page-open')
    }
  }, [playerOpen])

  const audioRef = useRef<HTMLAudioElement>(null)

  const [toast, setToast] = useState('')
  const [onlineSourceUrl, setOnlineSourceUrl] = useState('')
  const [sourceBusy, setSourceBusy] = useState(false)
  const [lxSourceStatus, setLxSourceStatus] =
    useState<LxMusicSourceStatus | null>(null)
  const [lxSourceChecking, setLxSourceChecking] = useState(true)
  const [updateAlert, setUpdateAlert] = useState<{
    source: string
    log: string
    updateUrl?: string
  } | null>(null)

  const lyricLines = useMemo(() => parseLrc(lyrics), [lyrics])
  const activeLyricIndex = useMemo(() => {
    let active = -1
    for (let index = 0; index < lyricLines.length; index += 1) {
      if (lyricLines[index].time <= currentTime + 0.12) active = index
      else break
    }
    return active
  }, [currentTime, lyricLines])

  const activeSource = sources.find((source) => source.id === activeSourceId)

  const showToast = (message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 2_800)
  }

  const runWindowAction = async (action: () => Promise<void>) => {
    try {
      await action()
    } catch (error) {
      showToast(`窗口操作失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const minimizeWindow = () =>
    runWindowAction(() => getCurrentWindow().minimize())

  const toggleWindowFullscreen = () =>
    runWindowAction(async () => {
      const currentWindow = getCurrentWindow()
      await currentWindow.setFullscreen(!(await currentWindow.isFullscreen()))
    })

  const closeWindow = () => runWindowAction(() => getCurrentWindow().close())

  useEffect(() => {
    settingsRef.current = settings
    localStorage.setItem('one-player:settings', JSON.stringify(settings))
  }, [settings])

  useEffect(() => {
    localStorage.setItem('one-player:favorites', JSON.stringify(favorites))
  }, [favorites])

  useEffect(() => {
    localStorage.setItem(
      'one-player:downloads',
      JSON.stringify(downloads.slice(0, 100)),
    )
  }, [downloads])

  useEffect(() => {
    const applyTheme = () => {
      const theme =
        settings.theme === 'system'
          ? window.matchMedia('(prefers-color-scheme: light)').matches
            ? 'light'
            : 'dark'
          : settings.theme
      document.documentElement.dataset.theme = theme
    }
    applyTheme()
    const media = window.matchMedia('(prefers-color-scheme: light)')
    media.addEventListener('change', applyTheme)
    return () => media.removeEventListener('change', applyTheme)
  }, [settings.theme])

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume
  }, [volume])

  useEffect(() => {
    if (!audioUrl || !audioRef.current) return
    audioRef.current
      .play()
      .then(() => setIsPlaying(true))
      .catch((error) => {
        setIsPlaying(false)
        showToast(`播放失败：${error instanceof Error ? error.message : String(error)}`)
      })
  }, [audioUrl])

  useEffect(() => {
    document
      .querySelector(`[data-lyric-index="${activeLyricIndex}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [activeLyricIndex])

  useEffect(() => {
    let cancelled = false
    void listCustomSources()
      .then(async (list) => {
        if (cancelled) return
        setSources(list)
        const saved = localStorage.getItem('one-player:active-source') ?? ''
        const selected = list.some((source) => source.id === saved)
          ? saved
          : list[0]?.id ?? ''
        await activateSource(selected, list)
      })
      .catch((error) => {
        if (!cancelled) showToast(`读取自定义源失败：${String(error)}`)
      })
    return () => {
      cancelled = true
      sourceActivationRef.current += 1
      runtimeRef.current?.dispose()
      runtimeRef.current = null
    }
    // The runtime lifecycle is intentionally initialized only once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let cancelled = false
    void detectLxMusicSource()
      .then((status) => {
        if (!cancelled) setLxSourceStatus(status)
      })
      .catch((error) => {
        if (!cancelled) {
          setLxSourceStatus({
            installed: false,
            canImport: false,
            message: `检测 LX Music 失败：${String(error)}`,
          })
        }
      })
      .finally(() => {
        if (!cancelled) setLxSourceChecking(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function activateSource(
    id: string,
    knownSources: CustomSourceInfo[] = sources,
    notify = false,
  ) {
    const activationId = sourceActivationRef.current + 1
    sourceActivationRef.current = activationId
    runtimeRef.current?.dispose()
    runtimeRef.current = null
    setActiveSourceId(id)
    localStorage.setItem('one-player:active-source', id)
    if (!id) {
      setSourceStatus({ state: 'idle', capabilities: {} })
      return
    }
    const source = knownSources.find((item) => item.id === id)
    if (!source) {
      setSourceStatus({
        state: 'error',
        message: '自定义源不存在',
        capabilities: {},
      })
      return
    }
    setSourceStatus({ state: 'loading', capabilities: {} })
    let runtime: SourceRuntime | null = null
    try {
      const script = await getCustomSourceScript(id)
      if (activationId !== sourceActivationRef.current) return
      runtime = new SourceRuntime({
        getProxy: () => settingsRef.current.proxy,
        onUpdateAlert: (alert) => {
          if (activationId !== sourceActivationRef.current) return
          if (!source.allowShowUpdateAlert) return
          setUpdateAlert({ source: source.name, ...alert })
        },
        onOpenDevTools: () => {
          if (activationId !== sourceActivationRef.current) return
          showToast('脚本请求打开调试工具，请在开发模式中检查控制台')
        },
      })
      runtimeRef.current = runtime
      const capabilities = await runtime.initialize(source, script)
      if (
        activationId !== sourceActivationRef.current ||
        runtimeRef.current !== runtime
      ) {
        runtime.dispose()
        return
      }
      setSourceStatus({ state: 'ready', capabilities })
      if (notify) showToast(`已切换到「${source.name}」`)
      const supportedProviders = Object.keys(capabilities).filter(
        (sourceKey): sourceKey is OnlineSourceKey =>
          sourceKey !== 'local' && sourceKey in providerNames,
      )
      if (!capabilities[provider]?.actions.includes('musicUrl')) {
        const first = supportedProviders.find(
          (sourceKey) => capabilities[sourceKey]?.actions.includes('musicUrl'),
        )
        if (first) setProvider(first)
      }
    } catch (error) {
      if (activationId !== sourceActivationRef.current) return
      runtime?.dispose()
      if (runtimeRef.current === runtime) runtimeRef.current = null
      setSourceStatus({
        state: 'error',
        message: error instanceof Error ? error.message : String(error),
        capabilities: {},
      })
    }
  }

  async function handleSearch(
    event?: FormEvent,
    targetPage = 1,
    targetQuery = query,
    targets: { provider?: OnlineSourceKey; searchMode?: SearchMode } = {},
  ) {
    event?.preventDefault()
    const keyword = targetQuery.trim()
    if (!keyword) return
    const requestId = searchRequestRef.current + 1
    searchRequestRef.current = requestId
    const nextProvider = targets.provider ?? provider
    const nextSearchMode = targets.searchMode ?? searchMode
    setSearching(true)
    setSearchError('')
    setAlbumDetail(null)
    try {
      if (nextSearchMode === 'album') {
        const result = await searchAlbums(
          nextProvider,
          keyword,
          targetPage,
          settingsRef.current,
        )
        if (requestId !== searchRequestRef.current) return
        setAlbumResults(result.list)
        setSearchResults([])
        setAllPage(result.allPage)
      } else {
        const result = await searchMusic(
          nextProvider,
          keyword,
          targetPage,
          settingsRef.current,
        )
        if (requestId !== searchRequestRef.current) return
        setSearchResults(result.list)
        setAlbumResults([])
        setAllPage(result.allPage)
      }
      setSearchedQuery(keyword)
      setPage(targetPage)
    } catch (error) {
      if (requestId !== searchRequestRef.current) return
      setSearchResults([])
      setAlbumResults([])
      setSearchError(error instanceof Error ? error.message : String(error))
    } finally {
      if (requestId === searchRequestRef.current) setSearching(false)
    }
  }

  async function openAlbum(album: AlbumSummary) {
    setSearching(true)
    setSearchError('')
    try {
      const detail = await getAlbumDetail(album, settingsRef.current)
      setAlbumDetail(detail)
    } catch (error) {
      setAlbumDetail(null)
      setSearchError(error instanceof Error ? error.message : String(error))
    } finally {
      setSearching(false)
    }
  }

  function resetSearchResultState() {
    setSearchedQuery('')
    setPage(1)
    setAllPage(1)
    setSearchResults([])
    setAlbumResults([])
    setAlbumDetail(null)
    setSearchError('')
  }

  function changeProvider(value: OnlineSourceKey) {
    setProvider(value)
    if (searchedQuery) {
      void handleSearch(undefined, 1, searchedQuery, { provider: value })
    } else {
      resetSearchResultState()
    }
  }

  function changeSearchMode(value: SearchMode) {
    setSearchMode(value)
    if (searchedQuery) {
      void handleSearch(undefined, 1, searchedQuery, { searchMode: value })
    } else {
      resetSearchResultState()
    }
  }

  function handleSearchContentScroll(event: UIEvent<HTMLDivElement>) {
    if (event.currentTarget.scrollTop > 96 && searchHeroExpanded) {
      setSearchHeroExpanded(false)
    }
  }

  function handleSearchContentWheel(event: WheelEvent<HTMLDivElement>) {
    if (
      !searchHeroExpanded &&
      event.currentTarget.scrollTop <= 0 &&
      event.deltaY < 0
    ) {
      setSearchHeroExpanded(true)
    }
  }

  async function resolveTrackUrl(track: MusicTrack) {
    if (!runtimeRef.current || sourceStatus.state !== 'ready') {
      throw new Error('请先在设置中导入并启用一个自定义源')
    }
    const capability = sourceStatus.capabilities[track.source]
    if (!capability?.actions.includes('musicUrl')) {
      throw new Error(
        `当前自定义源不支持 ${track.source.toUpperCase()} 音乐地址`,
      )
    }
    const quality = pickQuality(
      track,
      sourceStatus.capabilities,
      settings.playQuality,
    )
    const result = (await runtimeRef.current.request({
      source: track.source,
      action: 'musicUrl',
      info: {
        type: track.source === 'local' ? null : quality,
        musicInfo: track,
      },
    })) as {
      data?: { type?: Quality; url?: string }
    }
    if (!result.data?.url) throw new Error('自定义源没有返回播放地址')
    return { url: result.data.url, quality: result.data.type ?? quality }
  }

  async function loadTrackLyrics(track: MusicTrack) {
    const requestId = lyricRequestRef.current + 1
    lyricRequestRef.current = requestId
    setLyricsLoading(true)
    setLyrics(null)
    setLyricsError('')
    try {
      let nextLyrics: LyricPayload
      if (
        track.source === 'local' &&
        runtimeRef.current &&
        sourceStatus.capabilities.local?.actions.includes('lyric')
      ) {
        const result = (await runtimeRef.current.request({
          source: 'local',
          action: 'lyric',
          info: { musicInfo: track },
        })) as { data?: LyricPayload }
        if (!result.data) throw new Error('自定义源没有返回歌词')
        nextLyrics = result.data
      } else {
        nextLyrics = await getBuiltinLyrics(track, settings)
      }
      if (requestId === lyricRequestRef.current) setLyrics(nextLyrics)
    } catch (error) {
      if (requestId !== lyricRequestRef.current) return
      setLyrics(null)
      setLyricsError(error instanceof Error ? error.message : String(error))
    } finally {
      if (requestId === lyricRequestRef.current) setLyricsLoading(false)
    }
  }

  async function playTrack(track: MusicTrack, list: MusicTrack[] = queue) {
    setCurrentTrack(track)
    setQueue(list.length ? list : [track])
    setArtwork(track.img ?? null)
    setCurrentQuality(
      pickQuality(track, sourceStatus.capabilities, settings.playQuality),
    )
    setCurrentTime(0)
    setDuration(0)
    setIsResolving(true)
    setAudioUrl('')
    void loadTrackLyrics(track)
    void getBuiltinArtwork(track, settings)
      .then((url) => setArtwork(url))
      .catch(() => {})
    try {
      const resolved = await resolveTrackUrl(track)
      setCurrentQuality(resolved.quality)
      setAudioUrl(resolved.url)
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    } finally {
      setIsResolving(false)
    }
  }

  function playNext(direction = 1) {
    if (!currentTrack || !queue.length) return
    const index = queue.findIndex((track) => track.id === currentTrack.id)
    const nextIndex = (index + direction + queue.length) % queue.length
    void playTrack(queue[nextIndex], queue)
  }

  function togglePlayback() {
    if (!audioRef.current) return
    if (audioRef.current.paused) {
      void audioRef.current.play()
    } else {
      audioRef.current.pause()
    }
  }

  function seekTo(value: number) {
    if (!audioRef.current) return
    audioRef.current.currentTime = value
    setCurrentTime(value)
  }

  function toggleFavorite(track: MusicTrack) {
    setFavorites((current) =>
      current.some((item) => item.id === track.id)
        ? current.filter((item) => item.id !== track.id)
        : [track, ...current],
    )
  }

  async function downloadTrack(track: MusicTrack) {
    const downloadId = crypto.randomUUID()
    try {
      const currentSettings = settingsRef.current
      const { url, quality } = await resolveTrackUrl(track)
      const extension = quality === 'flac' || quality === 'flac24bit' ? 'flac' : 'mp3'
      const fileName = `${sanitizeFileName(`${track.singer} - ${track.name}`)}.${extension}`
      setDownloads((items) => [
        {
          id: downloadId,
          track,
          quality,
          status: 'downloading',
          createdAt: Date.now(),
        },
        ...items,
      ])
      const savedPath = await downloadFile({
        url,
        directory: currentSettings.downloadDirectory || undefined,
        fileName,
        proxy: currentSettings.proxy || undefined,
      })
      setDownloads((items) =>
        items.map((item) =>
          item.id === downloadId
            ? { ...item, status: 'done', path: savedPath }
            : item,
        ),
      )
      showToast(`已下载：${fileName}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setDownloads((items) =>
        items.map((item) =>
          item.id === downloadId ? { ...item, status: 'error', message } : item,
        ),
      )
      showToast(`下载失败：${message}`)
    }
  }

  async function handleLocalSourceImport() {
    const path = await open({
      multiple: false,
      directory: false,
      title: '选择 LX 自定义源脚本',
      filters: [{ name: 'JavaScript', extensions: ['js'] }],
    })
    if (typeof path !== 'string') return
    setSourceBusy(true)
    try {
      const source = await importCustomSourceFile(path)
      const list = [...sources, source]
      setSources(list)
      await activateSource(source.id, list)
      showToast(`已导入「${source.name}」`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    } finally {
      setSourceBusy(false)
    }
  }

  async function handleOnlineSourceImport() {
    const url = onlineSourceUrl.trim()
    if (!/^https?:\/\//i.test(url)) {
      showToast('请输入有效的 HTTP 或 HTTPS 地址')
      return
    }
    setSourceBusy(true)
    try {
      const response = await requestHttp({
        url,
        proxy: settings.proxy || undefined,
        timeoutMs: 30_000,
      })
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`下载脚本失败：HTTP ${response.statusCode}`)
      }
      const source = await importCustomSourceScript(response.bodyText)
      const list = [...sources, source]
      setSources(list)
      setOnlineSourceUrl('')
      await activateSource(source.id, list)
      showToast(`已导入「${source.name}」`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    } finally {
      setSourceBusy(false)
    }
  }

  async function refreshLxMusicSource() {
    setLxSourceChecking(true)
    try {
      setLxSourceStatus(await detectLxMusicSource())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setLxSourceStatus({
        installed: false,
        canImport: false,
        message: `检测 LX Music 失败：${message}`,
      })
      showToast(`检测 LX Music 失败：${message}`)
    } finally {
      setLxSourceChecking(false)
    }
  }

  async function handleLxSourceImport() {
    if (!lxSourceStatus?.canImport) return
    setSourceBusy(true)
    try {
      const result = await importLxMusicDefaultSource()
      const list = await listCustomSources()
      setSources(list)
      await activateSource(result.source.id, list)
      showToast(
        result.alreadyImported
          ? `已启用 LX 音源「${result.source.name}」`
          : `已从 LX Music 导入「${result.source.name}」`,
      )
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
      await refreshLxMusicSource()
    } finally {
      setSourceBusy(false)
    }
  }

  async function handleRemoveSource(source: CustomSourceInfo) {
    if (!window.confirm(`确定移除自定义源「${source.name}」吗？`)) return
    try {
      const list = await removeCustomSource(source.id)
      setSources(list)
      if (source.id === activeSourceId) {
        const next = list[0]?.id ?? ''
        await activateSource(next, list)
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleToggleUpdateAlert(source: CustomSourceInfo) {
    const enabled = !source.allowShowUpdateAlert
    try {
      await setCustomSourceUpdateAlert(source.id, enabled)
      setSources((items) =>
        items.map((item) =>
          item.id === source.id
            ? { ...item, allowShowUpdateAlert: enabled }
            : item,
        ),
      )
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    }
  }

  async function chooseDownloadDirectory() {
    try {
      const directory = await open({
        directory: true,
        multiple: false,
        title: '选择音乐下载目录',
        defaultPath: settingsRef.current.downloadDirectory || undefined,
      })
      if (typeof directory === 'string') {
        setSettings((current) => ({ ...current, downloadDirectory: directory }))
        showToast('下载目录已更新')
      }
    } catch (error) {
      showToast(
        `选择下载目录失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const navItems: Array<{ id: View; label: string; icon: typeof Search }> = [
    { id: 'search', label: '搜索', icon: Search },
    { id: 'library', label: '我的列表', icon: Library },
    { id: 'downloads', label: '下载', icon: Download },
    { id: 'settings', label: '设置', icon: Settings },
  ]

  return (
    <div className="app-shell">
      <audio
        ref={audioRef}
        src={audioUrl}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onDurationChange={(event) => setDuration(event.currentTarget.duration || 0)}
        onEnded={() => playNext(1)}
      />

      <div
        className={`window-controls ${playerOpen ? 'player-open' : ''}`}
        aria-label="窗口控制"
      >
        {playerOpen && currentTrack && (
          <button
            className="player-collapse-control"
            onClick={() => setPlayerOpen(false)}
            aria-label="收起播放详情"
            title="收起播放详情"
          >
            <Minimize2 size={15} />
          </button>
        )}
        <button
          onClick={() => void minimizeWindow()}
          aria-label="最小化窗口"
          title="最小化"
        >
          <Minus size={15} />
        </button>
        <button
          onClick={() => void toggleWindowFullscreen()}
          aria-label="切换全屏"
          title="切换全屏"
        >
          <Maximize2 size={14} />
        </button>
        <button
          className="close"
          onClick={() => void closeWindow()}
          aria-label="关闭窗口"
          title="关闭"
        >
          <X size={15} />
        </button>
      </div>

      <aside className="sidebar">
        <div className="brand" data-tauri-drag-region>
          <div className="brand-mark" data-tauri-drag-region>
            <Music2 size={20} />
          </div>
          <div data-tauri-drag-region>
            <strong>ONE</strong>
            <span>PLAYER</span>
          </div>
        </div>

        <nav>
          <p className="nav-label">音乐</p>
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                className={`nav-item ${view === item.id ? 'active' : ''}`}
                onClick={() => setView(item.id)}
              >
                <Icon size={19} />
                <span>{item.label}</span>
                {item.id === 'library' && favorites.length > 0 && (
                  <em>{favorites.length}</em>
                )}
              </button>
            )
          })}
        </nav>

        <div className="sidebar-source-card">
          <div className="source-card-heading">
            <span
              className={`status-dot ${sourceStatus.state}`}
              aria-hidden="true"
            />
            <span>自定义源</span>
          </div>
          <strong>{activeSource?.name ?? '尚未配置'}</strong>
          <small>
            {sourceStatus.state === 'ready'
              ? `${Object.keys(sourceStatus.capabilities).length} 个平台可用`
              : sourceStatus.state === 'loading'
                ? '正在初始化…'
                : sourceStatus.message ?? '前往设置导入脚本'}
          </small>
          <button onClick={() => setView('settings')}>
            {sources.length ? `管理 ${sources.length} 个音源` : '管理音源'}
          </button>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar" data-tauri-drag-region>
          <div className="topbar-drag-space" data-tauri-drag-region />
          <div className="topbar-title" data-tauri-drag-region>
            {view === 'search' && '探索音乐'}
            {view === 'library' && '我的列表'}
            {view === 'downloads' && '下载管理'}
            {view === 'settings' && '偏好设置'}
          </div>
          <div
            className={`source-switcher ${sourceStatus.state}`}
            title={
              sourceStatus.state === 'ready'
                ? `当前音源：${activeSource?.name ?? ''}`
                : sourceStatus.message ?? '音源未就绪'
            }
          >
            <span className={`status-dot ${sourceStatus.state}`} />
            <select
              value={activeSourceId}
              onChange={(event) =>
                void activateSource(event.target.value, sources, true)
              }
              disabled={!sources.length}
              aria-label="切换当前音源"
            >
              {!sources.length && <option value="">未配置音源</option>}
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </div>
        </header>

        <div
          className="content-scroll"
          onScroll={view === 'search' ? handleSearchContentScroll : undefined}
          onWheel={view === 'search' ? handleSearchContentWheel : undefined}
        >
          {view === 'search' && (
            <SearchView
              query={query}
              setQuery={setQuery}
              provider={provider}
              setProvider={changeProvider}
              searchMode={searchMode}
              setSearchMode={changeSearchMode}
              capabilities={sourceStatus.capabilities}
              playQuality={settings.playQuality}
              searching={searching}
              searchError={searchError}
              results={searchResults}
              albums={albumResults}
              albumDetail={albumDetail}
              favorites={favorites}
              searchedQuery={searchedQuery}
              heroExpanded={searchHeroExpanded}
              page={page}
              allPage={allPage}
              onSearch={handleSearch}
              onOpenAlbum={(album) => void openAlbum(album)}
              onCloseAlbum={() => {
                setAlbumDetail(null)
                setSearchError('')
              }}
              onPlay={(track, list) => void playTrack(track, list)}
              onFavorite={toggleFavorite}
              onDownload={(track) => void downloadTrack(track)}
            />
          )}

          {view === 'library' && (
            <section className="page-section">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">COLLECTION</span>
                  <h1>我的列表</h1>
                  <p>收藏的歌曲会保存在本机，不会上传。</p>
                </div>
                <div className="summary-chip">
                  <ListMusic size={18} />
                  {favorites.length} 首
                </div>
              </div>
              {favorites.length ? (
                <TrackTable
                  tracks={favorites}
                  favorites={favorites}
                  capabilities={sourceStatus.capabilities}
                  playQuality={settings.playQuality}
                  onPlay={(track) => void playTrack(track, favorites)}
                  onFavorite={toggleFavorite}
                  onDownload={(track) => void downloadTrack(track)}
                />
              ) : (
                <EmptyState
                  icon={<Heart size={30} />}
                  title="列表还是空的"
                  description="在搜索结果中点击心形按钮，把喜欢的歌放到这里。"
                  action="去搜索音乐"
                  onAction={() => setView('search')}
                />
              )}
            </section>
          )}

          {view === 'downloads' && (
            <DownloadsView downloads={downloads} />
          )}

          {view === 'settings' && (
            <SettingsView
              settings={settings}
              setSettings={setSettings}
              sources={sources}
              activeSourceId={activeSourceId}
              sourceStatus={sourceStatus}
              sourceBusy={sourceBusy}
              lxSourceStatus={lxSourceStatus}
              lxSourceChecking={lxSourceChecking}
              onlineSourceUrl={onlineSourceUrl}
              setOnlineSourceUrl={setOnlineSourceUrl}
              onActivate={(id) => void activateSource(id, sources, true)}
              onLocalImport={() => void handleLocalSourceImport()}
              onOnlineImport={() => void handleOnlineSourceImport()}
              onLxImport={() => void handleLxSourceImport()}
              onRefreshLx={() => void refreshLxMusicSource()}
              onRemove={(source) => void handleRemoveSource(source)}
              onToggleUpdate={(source) => void handleToggleUpdateAlert(source)}
              onChooseDirectory={() => void chooseDownloadDirectory()}
            />
          )}
        </div>
      </main>

      <PlayerBar
        track={currentTrack}
        artwork={artwork}
        quality={currentQuality}
        isPlaying={isPlaying}
        isResolving={isResolving}
        currentTime={currentTime}
        duration={duration}
        volume={volume}
        onVolume={setVolume}
        onToggle={togglePlayback}
        onPrevious={() => playNext(-1)}
        onNext={() => playNext(1)}
        onSeek={seekTo}
        onOpen={() => currentTrack && setPlayerOpen(true)}
      />

      {playerOpen && currentTrack && (
        <PlayerPage
          track={currentTrack}
          artwork={artwork}
          quality={currentQuality}
          isPlaying={isPlaying}
          isResolving={isResolving}
          currentTime={currentTime}
          duration={duration}
          lyricLines={lyricLines}
          activeLyricIndex={activeLyricIndex}
          lyricsLoading={lyricsLoading}
          lyricsError={lyricsError}
          onToggle={togglePlayback}
          onPrevious={() => playNext(-1)}
          onNext={() => playNext(1)}
          onSeek={seekTo}
        />
      )}

      {updateAlert && (
        <div className="modal-backdrop" onClick={() => setUpdateAlert(null)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setUpdateAlert(null)}>
              <X size={18} />
            </button>
            <div className="modal-icon">
              <RefreshCw size={22} />
            </div>
            <h2>发现音源更新</h2>
            <p className="modal-source">{updateAlert.source}</p>
            <pre>{updateAlert.log}</pre>
            <div className="modal-actions">
              {updateAlert.updateUrl && (
                <button
                  className="secondary-button"
                  onClick={() => {
                    void navigator.clipboard.writeText(updateAlert.updateUrl!)
                    showToast('更新地址已复制')
                  }}
                >
                  复制更新地址
                </button>
              )}
              <button className="primary-button" onClick={() => setUpdateAlert(null)}>
                知道了
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

interface SearchViewProps {
  query: string
  setQuery: (value: string) => void
  provider: OnlineSourceKey
  setProvider: (value: OnlineSourceKey) => void
  searchMode: SearchMode
  setSearchMode: (value: SearchMode) => void
  capabilities: SourceCapabilities
  playQuality: Quality
  searching: boolean
  searchError: string
  results: MusicTrack[]
  albums: AlbumSummary[]
  albumDetail: AlbumDetail | null
  favorites: MusicTrack[]
  searchedQuery: string
  heroExpanded: boolean
  page: number
  allPage: number
  onSearch: (
    event?: FormEvent,
    targetPage?: number,
    targetQuery?: string,
  ) => void
  onOpenAlbum: (album: AlbumSummary) => void
  onCloseAlbum: () => void
  onPlay: (track: MusicTrack, list: MusicTrack[]) => void
  onFavorite: (track: MusicTrack) => void
  onDownload: (track: MusicTrack) => void
}

function SearchView(props: SearchViewProps) {
  const detailTracks = props.albumDetail?.list ?? []
  const isAlbumMode = props.searchMode === 'album'
  const resultDescription = props.albumDetail
    ? `${props.albumDetail.album.singer} · ${detailTracks.length} 首`
    : isAlbumMode
      ? props.albums.length
        ? `${providerNames[props.provider]} · 当前页 ${props.albums.length} 张`
        : '输入专辑名称或歌手开始搜索'
      : props.results.length
        ? `${providerNames[props.provider]} · 当前页 ${props.results.length} 首`
        : '输入关键词开始搜索'

  return (
    <>
      <section
        className={`search-hero ${props.heroExpanded ? 'expanded' : 'collapsed'}`}
      >
        <div className="hero-orb orb-one" />
        <div className="hero-orb orb-two" />
        <div className="search-hero-intro" aria-hidden={!props.heroExpanded}>
          <div className="search-hero-intro-body">
            <span className="eyebrow">SEARCH · PLAY · KEEP</span>
            <h1>找到想听的声音</h1>
            <p>搜索公开音乐信息，通过你自己的 LX 兼容音源获取播放地址。</p>
          </div>
        </div>
        <div className="search-controls">
          <form className="search-box" onSubmit={(event) => props.onSearch(event)}>
            <Search size={22} />
            <input
              value={props.query}
              onChange={(event) => props.setQuery(event.target.value)}
              placeholder={
                isAlbumMode ? '搜索专辑或歌手' : '搜索歌曲、歌手或专辑'
              }
              autoFocus
            />
            <button type="submit" disabled={props.searching}>
              {props.searching ? <LoaderCircle className="spin" size={18} /> : '搜索'}
            </button>
          </form>
          <div className="search-options">
            <div className="search-mode-tabs" aria-label="搜索类型">
              <button
                className={props.searchMode === 'track' ? 'active' : ''}
                onClick={() => props.setSearchMode('track')}
              >
                歌曲
              </button>
              <button
                className={props.searchMode === 'album' ? 'active' : ''}
                onClick={() => props.setSearchMode('album')}
              >
                专辑
              </button>
            </div>
            <div className="provider-tabs">
              {(Object.keys(providerNames) as OnlineSourceKey[]).map((source) => {
                const playable =
                  props.capabilities[source]?.actions.includes('musicUrl') ?? false
                return (
                  <button
                    key={source}
                    className={props.provider === source ? 'active' : ''}
                    onClick={() => props.setProvider(source)}
                    title={playable ? '当前音源可播放' : '可搜索，但当前音源未声明支持'}
                  >
                    {providerNames[source]}
                    <span className={playable ? 'available' : ''} />
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="results-section">
        <div className="results-heading">
          <div>
            <h2>
              {props.albumDetail
                ? props.albumDetail.album.name
                : props.searchedQuery
                  ? `“${props.searchedQuery}”`
                  : '搜索结果'}
            </h2>
            <p>{resultDescription}</p>
          </div>
          {props.albumDetail ? (
            <button className="album-back-button" onClick={props.onCloseAlbum}>
              <ChevronLeft size={16} />
              返回专辑结果
            </button>
          ) : (
            props.allPage > 1 && (
              <div className="pagination">
                <button
                  disabled={props.page <= 1 || props.searching}
                  onClick={() =>
                    props.onSearch(undefined, props.page - 1, props.searchedQuery)
                  }
                >
                  <ChevronLeft size={17} />
                </button>
                <span>
                  {props.page} / {props.allPage}
                </span>
                <button
                  disabled={props.page >= props.allPage || props.searching}
                  onClick={() =>
                    props.onSearch(undefined, props.page + 1, props.searchedQuery)
                  }
                >
                  <ChevronRight size={17} />
                </button>
              </div>
            )
          )}
        </div>
        {props.searchError ? (
          <div className="inline-error">
            <CircleAlert size={20} />
            <div>
              <strong>搜索失败</strong>
              <span>{props.searchError}</span>
            </div>
          </div>
        ) : props.searching &&
          (isAlbumMode ? !props.albumDetail : !props.results.length) ? (
          <div className="loading-state">
            <LoaderCircle className="spin" size={28} />
            <span>
              {props.albums.length && isAlbumMode
                ? '正在加载专辑曲目…'
                : `正在搜索${isAlbumMode ? '专辑' : providerNames[props.provider]}…`}
            </span>
          </div>
        ) : props.albumDetail ? (
          <>
            <div className="album-detail-summary">
              <div className="album-detail-cover">
                {props.albumDetail.album.img ? (
                  <img
                    src={props.albumDetail.album.img}
                    alt=""
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <Music2 size={30} />
                )}
              </div>
              <div>
                <span className="eyebrow">
                  {providerNames[props.albumDetail.album.source]} · ALBUM
                </span>
                <strong>{props.albumDetail.album.name}</strong>
                <p>
                  {props.albumDetail.album.singer}
                  {props.albumDetail.album.publishTime
                    ? ` · ${props.albumDetail.album.publishTime}`
                    : ''}
                </p>
              </div>
              <button
                className="primary-button album-play-button"
                disabled={!detailTracks.length}
                onClick={() =>
                  detailTracks[0] &&
                  props.onPlay(detailTracks[0], detailTracks)
                }
              >
                <Play size={16} fill="currentColor" />
                播放整张
              </button>
            </div>
            <TrackTable
              tracks={detailTracks}
              favorites={props.favorites}
              capabilities={props.capabilities}
              playQuality={props.playQuality}
              onPlay={(track) => props.onPlay(track, detailTracks)}
              onFavorite={props.onFavorite}
              onDownload={props.onDownload}
            />
          </>
        ) : isAlbumMode && props.albums.length ? (
          <div className="album-grid">
            {props.albums.map((album) => (
              <button
                className="album-card"
                key={`${album.source}_${album.id}`}
                onClick={() => props.onOpenAlbum(album)}
              >
                <div className="album-card-cover">
                  {album.img ? (
                    <img src={album.img} alt="" referrerPolicy="no-referrer" />
                  ) : (
                    <Music2 size={25} />
                  )}
                </div>
                <div className="album-card-info">
                  <strong>{album.name}</strong>
                  <span>{album.singer || '未知歌手'}</span>
                  <small>
                    {[album.publishTime, album.songCount && `${album.songCount} 首`]
                      .filter(Boolean)
                      .join(' · ') || providerNames[album.source]}
                  </small>
                </div>
              </button>
            ))}
          </div>
        ) : props.results.length ? (
          <TrackTable
            tracks={props.results}
            favorites={props.favorites}
            capabilities={props.capabilities}
            playQuality={props.playQuality}
            onPlay={(track) => props.onPlay(track, props.results)}
            onFavorite={props.onFavorite}
            onDownload={props.onDownload}
          />
        ) : null}
      </section>
    </>
  )
}

interface TrackTableProps {
  tracks: MusicTrack[]
  favorites: MusicTrack[]
  capabilities: SourceCapabilities
  playQuality: Quality
  onPlay: (track: MusicTrack) => void
  onFavorite: (track: MusicTrack) => void
  onDownload: (track: MusicTrack) => void
}

function TrackTable({
  tracks,
  favorites,
  capabilities,
  playQuality,
  onPlay,
  onFavorite,
  onDownload,
}: TrackTableProps) {
  return (
    <div className="track-table">
      <div className="track-table-head">
        <span>#</span>
        <span>歌曲</span>
        <span>专辑</span>
        <span>播放音质</span>
        <span>时长</span>
        <span />
      </div>
      {tracks.map((track, index) => {
        const liked = favorites.some((item) => item.id === track.id)
        const playbackQuality = pickQuality(
          track,
          capabilities,
          playQuality,
        )
        const canResolveQuality = hasPlaybackQuality(track, capabilities)
        const highestQuality = [...track.types]
          .sort(
            (left, right) =>
              qualityOrder.indexOf(right.type) - qualityOrder.indexOf(left.type),
          )
          .at(0)?.type
        return (
          <div className="track-row" key={`${track.id}-${index}`}>
            <button className="track-index" onClick={() => onPlay(track)}>
              <span>{(index + 1).toString().padStart(2, '0')}</span>
              <Play size={15} fill="currentColor" />
            </button>
            <div className="track-main">
              <Artwork track={track} size="small" />
              <div>
                <strong title={track.name}>{track.name}</strong>
                <span title={track.singer}>{track.singer || '未知歌手'}</span>
              </div>
            </div>
            <span className="track-album" title={track.albumName}>
              {track.albumName || '—'}
            </span>
            <span
              className="quality-badge"
              title={
                highestQuality && highestQuality !== playbackQuality
                  ? `歌曲最高支持${qualityNames[highestQuality]}，按当前设置播放${qualityNames[playbackQuality]}`
                  : `按当前设置播放${qualityNames[playbackQuality]}`
              }
            >
              {canResolveQuality ? qualityNames[playbackQuality] : '不可用'}
            </span>
            <span className="track-duration">{track.interval ?? '—'}</span>
            <div className="track-actions">
              <button
                className={liked ? 'liked' : ''}
                aria-label={liked ? '取消收藏' : '收藏'}
                onClick={() => onFavorite(track)}
              >
                <Heart size={17} fill={liked ? 'currentColor' : 'none'} />
              </button>
              <button aria-label="下载" onClick={() => onDownload(track)}>
                <Download size={17} />
              </button>
              <button aria-label="播放" onClick={() => onPlay(track)}>
                <MoreHorizontal size={18} />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Artwork({
  track,
  url,
  size,
}: {
  track: MusicTrack
  url?: string | null
  size: 'small' | 'medium' | 'large'
}) {
  const image = url ?? track.img
  if (image) {
    return (
      <img
        className={`artwork artwork-${size}`}
        src={image}
        alt=""
        referrerPolicy="no-referrer"
      />
    )
  }
  return (
    <div className={`artwork artwork-${size} artwork-fallback`}>
      <span>{track.name.slice(0, 1).toUpperCase()}</span>
      <Music2 size={size === 'large' ? 38 : 16} />
    </div>
  )
}

function DownloadsView({ downloads }: { downloads: DownloadItem[] }) {
  return (
    <section className="page-section">
      <div className="section-heading">
        <div>
          <span className="eyebrow">OFFLINE</span>
          <h1>下载管理</h1>
          <p>音乐文件由 Rust 后端直接写入你选择的目录。</p>
        </div>
        <div className="summary-chip">
          <Download size={18} />
          {downloads.filter((item) => item.status === 'done').length} 个文件
        </div>
      </div>
      {downloads.length ? (
        <div className="download-list">
          {downloads.map((item) => (
            <div className="download-row" key={item.id}>
              <Artwork track={item.track} size="small" />
              <div className="download-info">
                <strong>{item.track.name}</strong>
                <span>
                  {item.track.singer} · {qualityNames[item.quality]}
                </span>
              </div>
              <div className={`download-status ${item.status}`}>
                {item.status === 'downloading' && (
                  <>
                    <LoaderCircle className="spin" size={16} />
                    下载中
                  </>
                )}
                {item.status === 'done' && (
                  <>
                    <span className="done-dot" />
                    已完成
                  </>
                )}
                {item.status === 'error' && (
                  <>
                    <CircleAlert size={16} />
                    {item.message ?? '下载失败'}
                  </>
                )}
              </div>
              <span className="download-path" title={item.path}>
                {item.path ?? '—'}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Download size={30} />}
          title="还没有下载任务"
          description="从搜索结果或我的列表中点击下载按钮。"
        />
      )}
    </section>
  )
}

interface SettingsViewProps {
  settings: AppSettings
  setSettings: (
    value: AppSettings | ((current: AppSettings) => AppSettings),
  ) => void
  sources: CustomSourceInfo[]
  activeSourceId: string
  sourceStatus: SourceStatus
  sourceBusy: boolean
  lxSourceStatus: LxMusicSourceStatus | null
  lxSourceChecking: boolean
  onlineSourceUrl: string
  setOnlineSourceUrl: (value: string) => void
  onActivate: (id: string) => void
  onLocalImport: () => void
  onOnlineImport: () => void
  onLxImport: () => void
  onRefreshLx: () => void
  onRemove: (source: CustomSourceInfo) => void
  onToggleUpdate: (source: CustomSourceInfo) => void
  onChooseDirectory: () => void
}

function SettingsView(props: SettingsViewProps) {
  return (
    <section className="page-section settings-page">
      <div className="section-heading">
        <div>
          <span className="eyebrow">PREFERENCES</span>
          <h1>设置</h1>
          <p>播放、下载和自定义源都只在本机生效。</p>
        </div>
      </div>

      <div className="settings-grid">
        <div className="settings-card">
          <div className="settings-card-title">
            <div className="settings-icon">
              <Home size={19} />
            </div>
            <div>
              <h2>通用</h2>
              <p>界面与默认播放偏好</p>
            </div>
          </div>
          <SettingRow label="主题">
            <div className="segmented">
              {(['dark', 'light', 'system'] as const).map((theme) => (
                <button
                  key={theme}
                  className={props.settings.theme === theme ? 'active' : ''}
                  onClick={() =>
                    props.setSettings((current) => ({ ...current, theme }))
                  }
                >
                  {theme === 'dark' ? '深色' : theme === 'light' ? '浅色' : '跟随系统'}
                </button>
              ))}
            </div>
          </SettingRow>
          <SettingRow label="默认音质">
            <select
              value={props.settings.playQuality}
              onChange={(event) =>
                props.setSettings((current) => ({
                  ...current,
                  playQuality: event.target.value as Quality,
                }))
              }
            >
              {qualityOrder.map((quality) => (
                <option key={quality} value={quality}>
                  {qualityNames[quality]} · {quality}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow
            label="下载目录"
            description="未设置时使用当前用户的系统下载目录"
          >
            <div className="path-control">
              <span title={props.settings.downloadDirectory}>
                {props.settings.downloadDirectory || '系统下载目录（默认）'}
              </span>
              <button
                className="path-select-button"
                onClick={props.onChooseDirectory}
                aria-label="选择下载目录"
              >
                <FolderOpen size={15} />
                选择目录
              </button>
              {props.settings.downloadDirectory && (
                <button
                  className="path-reset-button"
                  onClick={() =>
                    props.setSettings((current) => ({
                      ...current,
                      downloadDirectory: '',
                    }))
                  }
                  aria-label="恢复使用系统下载目录"
                  title="恢复使用系统下载目录"
                >
                  <X size={16} />
                </button>
              )}
            </div>
          </SettingRow>
          <SettingRow label="HTTP 代理" description="自定义源请求、搜索和下载共用">
            <input
              className="setting-input"
              value={props.settings.proxy}
              onChange={(event) =>
                props.setSettings((current) => ({
                  ...current,
                  proxy: event.target.value,
                }))
              }
              placeholder="例如 http://127.0.0.1:7890"
            />
          </SettingRow>
        </div>

        <div className="settings-card source-manager-card">
          <div className="settings-card-title">
            <div className="settings-icon accent">
              <Music2 size={19} />
            </div>
            <div>
              <h2>音源管理</h2>
              <p>可导入多个音源，同时仅启用一个</p>
            </div>
            <span className={`connection-badge ${props.sourceStatus.state}`}>
              {props.sourceStatus.state === 'ready'
                ? `${props.sources.length} 个 · 运行中`
                : props.sourceStatus.state === 'loading'
                  ? '初始化'
                  : props.sourceStatus.state === 'error'
                    ? '异常'
                    : '未启用'}
            </span>
          </div>

          {props.sourceStatus.state === 'error' && (
            <div className="source-error">
              <CircleAlert size={18} />
              <span>{props.sourceStatus.message}</span>
              {props.activeSourceId && (
                <button
                  onClick={() => props.onActivate(props.activeSourceId)}
                  disabled={props.sourceBusy}
                >
                  <RefreshCw size={14} />
                  重试
                </button>
              )}
            </div>
          )}

          <div
            className={`lx-import-panel ${
              props.lxSourceStatus?.installed ? 'available' : 'unavailable'
            }`}
            title={
              props.lxSourceStatus?.dataPath ??
              props.lxSourceStatus?.installPath ??
              undefined
            }
          >
            <div className="lx-import-main">
              <div className="lx-import-icon">
                <Music2 size={18} />
              </div>
              <div>
                <div className="lx-import-heading">
                  <strong>从 LX Music 一键导入</strong>
                  <span>
                    {props.lxSourceChecking
                      ? '检测中'
                      : props.lxSourceStatus?.installed
                        ? '已安装'
                        : '未安装'}
                  </span>
                </div>
                <p>
                  {props.lxSourceChecking
                    ? '正在检测 LX Music 和默认音源配置…'
                    : props.lxSourceStatus?.message ??
                      '尚未检测 LX Music'}
                </p>
                {props.lxSourceStatus?.source && (
                  <small>
                    {props.lxSourceStatus.source.name}
                    {props.lxSourceStatus.source.version
                      ? ` · v${props.lxSourceStatus.source.version}`
                      : ''}
                    {props.lxSourceStatus.source.author
                      ? ` · ${props.lxSourceStatus.source.author}`
                      : ''}
                  </small>
                )}
              </div>
            </div>
            <div className="lx-import-actions">
              <button
                className="icon-button"
                onClick={props.onRefreshLx}
                disabled={props.lxSourceChecking || props.sourceBusy}
                aria-label="重新检测 LX Music"
                title="重新检测"
              >
                <RefreshCw
                  className={props.lxSourceChecking ? 'spin' : undefined}
                  size={16}
                />
              </button>
              <button
                className="lx-import-button"
                onClick={props.onLxImport}
                disabled={
                  props.sourceBusy ||
                  props.lxSourceChecking ||
                  !props.lxSourceStatus?.canImport
                }
              >
                {props.sourceBusy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Upload size={16} />
                )}
                导入并启用
              </button>
            </div>
          </div>

          <div className="source-import-row">
            <button
              className="secondary-button"
              onClick={props.onLocalImport}
              disabled={props.sourceBusy}
            >
              <Upload size={17} />
              本地导入
            </button>
            <div className="online-import">
              <input
                value={props.onlineSourceUrl}
                onChange={(event) => props.setOnlineSourceUrl(event.target.value)}
                placeholder="https://example.com/source.js"
              />
              <button
                onClick={props.onOnlineImport}
                disabled={props.sourceBusy}
                aria-label="在线导入"
              >
                {props.sourceBusy ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <Plus size={18} />
                )}
              </button>
            </div>
          </div>

          <div className="source-list">
            {props.sources.map((source) => {
              const active = source.id === props.activeSourceId
              return (
                <div className={`source-item ${active ? 'active' : ''}`} key={source.id}>
                  <button
                    className="source-radio"
                    onClick={() => props.onActivate(source.id)}
                    aria-label={`启用 ${source.name}`}
                    aria-pressed={active}
                    title={active ? '当前使用的音源' : `切换到 ${source.name}`}
                  >
                    <span />
                  </button>
                  <div className="source-item-main">
                    <div>
                      <strong>{source.name}</strong>
                      {source.version && <em>v{source.version}</em>}
                    </div>
                    <p>{source.description || '没有描述'}</p>
                    <small>
                      {source.author || '未知作者'}
                      {active ? (
                        <>
                          {' · '}
                          {props.sourceStatus.state === 'loading'
                            ? '正在切换…'
                            : props.sourceStatus.state === 'error'
                              ? '当前使用 · 初始化失败'
                              : `当前使用${
                                  props.sourceStatus.state === 'ready'
                                    ? ` · ${Object.keys(
                                        props.sourceStatus.capabilities,
                                      )
                                        .map((key) => key.toUpperCase())
                                        .join(' / ')}`
                                    : ''
                                }`}
                        </>
                      ) : (
                        ' · 点击左侧切换'
                      )}
                    </small>
                  </div>
                  <label className="switch" title="允许显示更新提示">
                    <input
                      type="checkbox"
                      checked={source.allowShowUpdateAlert}
                      onChange={() => props.onToggleUpdate(source)}
                    />
                    <span />
                  </label>
                  <button
                    className="icon-button danger"
                    onClick={() => props.onRemove(source)}
                    aria-label="移除"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              )
            })}
            {!props.sources.length && (
              <div className="source-empty">
                <Music2 size={24} />
                <strong>还没有自定义源</strong>
                <span>导入 LX Music Desktop 自定义源脚本后即可播放和下载。</span>
              </div>
            )}
          </div>
          <div className="source-security-note">
            <CircleAlert size={16} />
            <span>
              脚本运行在独立 Web Worker 中；只有 LX 协议桥接的网络、加密和压缩能力可用。
            </span>
          </div>
        </div>
      </div>
    </section>
  )
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="setting-row">
      <div>
        <strong>{label}</strong>
        {description && <span>{description}</span>}
      </div>
      {children}
    </div>
  )
}

interface PlayerBarProps {
  track: MusicTrack | null
  artwork: string | null
  quality: Quality
  isPlaying: boolean
  isResolving: boolean
  currentTime: number
  duration: number
  volume: number
  onVolume: (value: number) => void
  onToggle: () => void
  onPrevious: () => void
  onNext: () => void
  onSeek: (value: number) => void
  onOpen: () => void
}

function PlayerBar(props: PlayerBarProps) {
  return (
    <footer className="player-bar">
      <button className="now-playing" onClick={props.onOpen} disabled={!props.track}>
        {props.track ? (
          <>
            <Artwork track={props.track} url={props.artwork} size="medium" />
            <div>
              <strong>{props.track.name}</strong>
              <span>{props.track.singer}</span>
            </div>
            <span className="quality-badge">{qualityNames[props.quality]}</span>
          </>
        ) : (
          <>
            <div className="empty-artwork">
              <Music2 size={20} />
            </div>
            <div>
              <strong>还没有播放音乐</strong>
              <span>从搜索结果选择一首歌</span>
            </div>
          </>
        )}
      </button>

      <div className="player-center">
        <div className="player-controls">
          <button onClick={props.onPrevious} disabled={!props.track}>
            <SkipBack size={18} fill="currentColor" />
          </button>
          <button
            className="play-button"
            onClick={props.onToggle}
            disabled={!props.track || props.isResolving}
          >
            {props.isResolving ? (
              <LoaderCircle className="spin" size={20} />
            ) : props.isPlaying ? (
              <Pause size={20} fill="currentColor" />
            ) : (
              <Play size={20} fill="currentColor" />
            )}
          </button>
          <button onClick={props.onNext} disabled={!props.track}>
            <SkipForward size={18} fill="currentColor" />
          </button>
        </div>
        <div className="progress-row">
          <span>{formatClock(props.currentTime)}</span>
          <input
            type="range"
            min={0}
            max={props.duration || 0}
            value={Math.min(props.currentTime, props.duration || 0)}
            onChange={(event) => props.onSeek(Number(event.target.value))}
          />
          <span>{formatClock(props.duration)}</span>
        </div>
      </div>

      <div className="player-extras">
        <Volume2 size={18} />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={props.volume}
          onChange={(event) => props.onVolume(Number(event.target.value))}
        />
        <button onClick={props.onOpen} disabled={!props.track} aria-label="打开播放页">
          <Maximize2 size={18} />
        </button>
      </div>
    </footer>
  )
}

interface PlayerPageProps {
  track: MusicTrack
  artwork: string | null
  quality: Quality
  isPlaying: boolean
  isResolving: boolean
  currentTime: number
  duration: number
  lyricLines: LyricLine[]
  activeLyricIndex: number
  lyricsLoading: boolean
  lyricsError: string
  onToggle: () => void
  onPrevious: () => void
  onNext: () => void
  onSeek: (value: number) => void
}

function PlayerPage(props: PlayerPageProps) {
  const [viewport, setViewport] = useState(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  }))

  useEffect(() => {
    let animationFrame = 0
    const updateViewport = () => {
      cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(() => {
        setViewport({
          width: document.documentElement.clientWidth,
          height: document.documentElement.clientHeight,
        })
      })
    }
    const resizeObserver = new ResizeObserver(updateViewport)
    resizeObserver.observe(document.documentElement)
    window.addEventListener('resize', updateViewport)
    updateViewport()

    return () => {
      cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      window.removeEventListener('resize', updateViewport)
    }
  }, [])

  const coverSize = Math.floor(
    Math.max(
      140,
      Math.min(350, viewport.width * 0.33, (viewport.height - 280) * 0.72),
    ),
  )
  const artworkBackground = props.artwork
    ? `linear-gradient(100deg, rgba(7, 10, 13, 0.94), rgba(10, 13, 17, 0.86)), radial-gradient(circle at 18% 30%, rgba(134, 239, 98, 0.08), transparent 35%), url("${props.artwork.replaceAll('"', '\\"')}")`
    : 'radial-gradient(circle at 18% 30%, rgba(134, 239, 98, 0.08), transparent 35%), linear-gradient(100deg, #070a0d, #0a0d11)'

  return (
    <div
      className="player-page"
      style={
        {
          '--player-cover-size': `${coverSize}px`,
          backgroundImage: artworkBackground,
        } as CSSProperties
      }
    >
      <div className="player-page-toolbar" data-tauri-drag-region>
      </div>
      <div className="player-page-content">
        <section className="player-album-panel">
          <div className="album-shadow">
            <Artwork track={props.track} url={props.artwork} size="large" />
          </div>
          <span className="eyebrow">
            NOW PLAYING · {props.track.source.toUpperCase()}
          </span>
          <h1>{props.track.name}</h1>
          <p>
            {props.track.singer}
            {props.track.albumName ? ` · ${props.track.albumName}` : ''}
          </p>
          <span className="quality-badge large">
            {qualityNames[props.quality]} · {props.quality}
          </span>
          <div className="player-page-progress">
            <input
              type="range"
              min={0}
              max={props.duration || 0}
              value={Math.min(props.currentTime, props.duration || 0)}
              onChange={(event) => props.onSeek(Number(event.target.value))}
            />
            <div>
              <span>{formatClock(props.currentTime)}</span>
              <span>{formatClock(props.duration)}</span>
            </div>
          </div>
          <div className="player-page-controls">
            <button onClick={props.onPrevious}>
              <SkipBack size={24} fill="currentColor" />
            </button>
            <button className="hero-play-button" onClick={props.onToggle}>
              {props.isResolving ? (
                <LoaderCircle className="spin" size={28} />
              ) : props.isPlaying ? (
                <Pause size={28} fill="currentColor" />
              ) : (
                <Play size={28} fill="currentColor" />
              )}
            </button>
            <button onClick={props.onNext}>
              <SkipForward size={24} fill="currentColor" />
            </button>
          </div>
        </section>
        <section className="lyrics-panel">
          <div className="lyrics-heading">
            <span>歌词</span>
            <small>随播放进度自动滚动</small>
          </div>
          <div className="lyrics-scroll">
            {props.lyricsLoading ? (
              <div className="lyrics-empty">
                <LoaderCircle className="spin" size={25} />
                正在获取歌词
              </div>
            ) : props.lyricLines.length ? (
              props.lyricLines.map((line, index) => (
                <button
                  key={`${line.time}-${index}`}
                  data-lyric-index={index}
                  className={`lyric-line ${
                    props.activeLyricIndex === index ? 'active' : ''
                  }`}
                  onClick={() => props.onSeek(line.time)}
                >
                  <span>{line.text}</span>
                  {line.translation && <small>{line.translation}</small>}
                </button>
              ))
            ) : props.lyricsError ? (
              <div className="lyrics-empty error">
                <CircleAlert size={24} />
                <strong>歌词加载失败</strong>
                <span>{props.lyricsError}</span>
              </div>
            ) : (
              <div className="lyrics-empty">
                <Music2 size={28} />
                暂无歌词
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function EmptyState({
  icon,
  title,
  description,
  action,
  onAction,
}: {
  icon: React.ReactNode
  title: string
  description: string
  action?: string
  onAction?: () => void
}) {
  return (
    <div className="empty-state">
      <div>{icon}</div>
      <strong>{title}</strong>
      <span>{description}</span>
      {action && onAction && <button onClick={onAction}>{action}</button>}
    </div>
  )
}

export default App

