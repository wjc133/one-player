import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Disc3,
  Download,
  FolderOpen,
  Heart,
  Home,
  Library,
  ListEnd,
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
  Repeat,
  Repeat1,
  RefreshCw,
  Search,
  Settings,
  Shuffle,
  SkipBack,
  SkipForward,
  Trash2,
  Upload,
  Volume2,
  Usb,
  HardDrive,
  X,
} from 'lucide-react'
import {
  type CSSProperties,
  type FormEvent,
  type MouseEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type {
  AlbumDetail,
  AlbumSummary,
  AppSettings,
  CustomSourceInfo,
  DownloadedAudio,
  DownloadProgress,
  DownloadTask,
  LegacyDownloadItem,
  LocalMusicMetadata,
  LxMusicSourceStatus,
  LyricPayload,
  MusicTrack,
  OnlineSourceKey,
  PlayList,
  Quality,
  SavedAlbum,
  SourceCapabilities,
  SourceStatus,
  WalkmanDevice,
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
import { WalkmanPage } from './components/WalkmanPage'
import {
  deleteDownload,
  detectLxMusicSource,
  detectWalkman,
  transferWalkmanFile,
  downloadFile,
  getDownloadFileUrl,
  getLocalMusicFileUrl,
  inspectLocalMusicFiles,
  claimDownloadFile,
  getCustomSourceScript,
  importCustomSourceFile,
  importCustomSourceScript,
  importLxMusicDefaultSource,
  listDownloads,
  listCustomSources,
  removeCustomSource,
  requestHttp,
  setCustomSourceUpdateAlert,
} from './lib/tauri'

type View = 'search' | 'library' | 'downloads' | 'walkman' | 'settings'
type SearchMode = 'track' | 'album'

const PLAYER_PAGE_TRANSITION_MS = 520
const PLAYBACK_FADE_MS = 300
const ALBUM_COLLECTION_ID = 'favorite-albums'
const FAVORITE_ALBUMS_STORAGE_KEY = 'one-player:favorite-albums'
const PLAYBACK_MODE_STORAGE_KEY = 'one-player:playback-mode'
const LOCAL_AUDIO_EXTENSIONS = ['mp3', 'flac', 'wav', 'ape', 'dsf', 'm4a', 'aac', 'ogg', 'opus', 'aiff', 'aif', 'wv']

type PlaybackMode = 'sequence' | 'loop' | 'one' | 'random'

const playbackModes: Array<{
  value: PlaybackMode
  label: string
  icon: typeof Repeat
}> = [
  { value: 'sequence', label: '顺序播放', icon: ListEnd },
  { value: 'loop', label: '循环播放', icon: Repeat },
  { value: 'one', label: '单曲循环', icon: Repeat1 },
  { value: 'random', label: '随机播放', icon: Shuffle },
]

const isPlaybackMode = (value: unknown): value is PlaybackMode =>
  playbackModes.some((mode) => mode.value === value)

const loadPlaybackMode = (): PlaybackMode => {
  const value = localStorage.getItem(PLAYBACK_MODE_STORAGE_KEY)
  return isPlaybackMode(value) ? value : 'sequence'
}

interface LyricLine {
  time: number
  text: string
  translation?: string
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  playQuality: '320k',
  downloadDirectory: '',
  downloadAlbumsOnFavorite: false,
  overwriteExistingTags: true,
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

const loadSettings = (): AppSettings => ({
  ...DEFAULT_SETTINGS,
  ...loadJson<Partial<AppSettings>>('one-player:settings', {}),
})

const loadPlaylists = (): PlayList[] => {
  const playlists = loadJson<PlayList[] | null>('one-player:playlists', null)
  if (Array.isArray(playlists) && playlists.length) {
    return playlists.map((playlist) => ({
      ...playlist,
      tracks: Array.isArray(playlist.tracks) ? playlist.tracks : [],
    }))
  }

  const favorites = loadJson<MusicTrack[]>('one-player:favorites', [])
  return [
    {
      id: 'default',
      name: '我的收藏',
      tracks: favorites,
      createdAt: Date.now(),
    },
  ]
}

const loadFavoriteAlbums = (): SavedAlbum[] => {
  const albums = loadJson<Array<SavedAlbum | AlbumSummary>>(
    FAVORITE_ALBUMS_STORAGE_KEY,
    [],
  )
  if (!Array.isArray(albums)) return []
  return albums.map((item): SavedAlbum => {
    if ('album' in item) {
      return {
        album: item.album,
        tracks: Array.isArray(item.tracks) ? item.tracks : [],
        savedAt: item.savedAt || Date.now(),
        coverDataUrl: item.coverDataUrl,
      }
    }
    return {
      album: item,
      tracks: [],
      savedAt: Date.now(),
    }
  })
}

const albumCollectionKey = (album: AlbumSummary) =>
  `${album.source}:${album.id || album.albumMid || `${album.singer}:${album.name}`}`

const isSameTrack = (left: MusicTrack, right: MusicTrack) =>
  left.source === right.source && left.id === right.id

const createShuffledQueue = (
  tracks: MusicTrack[],
  firstTrack?: MusicTrack | null,
  avoidFirstTrack?: MusicTrack | null,
) => {
  const shuffled = [...tracks]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1))
    ;[shuffled[index], shuffled[randomIndex]] = [
      shuffled[randomIndex],
      shuffled[index],
    ]
  }
  if (firstTrack) {
    const firstIndex = shuffled.findIndex((track) =>
      isSameTrack(track, firstTrack),
    )
    if (firstIndex > 0) {
      shuffled.unshift(...shuffled.splice(firstIndex, 1))
    }
  }
  if (
    avoidFirstTrack &&
    shuffled.length > 1 &&
    isSameTrack(shuffled[0], avoidFirstTrack)
  ) {
    ;[shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]]
  }
  return shuffled
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

const localMusicTrack = (metadata: LocalMusicMetadata): MusicTrack => {
  const quality: Quality = metadata.extension === 'flac' ? 'flac' : '320k'

  return {
    id: metadata.path,
    name: metadata.title,
    singer: metadata.artist || '本地音乐',
    source: 'local',
    songmid: metadata.path,
    interval: formatClock(metadata.durationSeconds),
    albumName: metadata.album,
    img: metadata.coverDataUrl ?? null,
    types: [{ type: quality, size: null }],
    _types: { [quality]: { size: null } },
    typeUrl: {},
    filePath: metadata.path,
    ext: metadata.extension,
    isLocalLibrary: true,
    downloadKey: metadata.trackKey,
  }
}

const trackDownloadKey = (track: MusicTrack) => {
  if (track.downloadKey) return track.downloadKey
  const stableId =
    String(track.id || track.songmid || track.filePath || '').trim() ||
    `${track.singer}-${track.name}`
  return `${track.source}:${stableId}`
}

const normalizeDownloadText = (value: string) =>
  value.trim().toLocaleLowerCase()

const isTrackDownloaded = (
  track: MusicTrack,
  files: DownloadedAudio[],
) => {
  const key = trackDownloadKey(track)
  const title = normalizeDownloadText(track.name)
  const artist = normalizeDownloadText(track.singer)
  return files.some(
    (file) =>
      file.trackKey === key ||
      (!file.trackKey &&
        normalizeDownloadText(file.title) === title &&
        normalizeDownloadText(file.artist) === artist),
  )
}

interface TrackDownloadState {
  status: 'idle' | 'downloading' | 'done'
  progress: number | null
  canChooseDestination?: boolean
}

type DownloadOutcome = 'downloaded' | 'skipped' | 'failed'

interface DownloadTrackOptions {
  walkmanId?: string
  silent?: boolean
}

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

const trackAlbumSummary = (track: MusicTrack): AlbumSummary | null => {
  if (track.source === 'local' || !track.albumName.trim()) return null
  const id = String(track.albumMid ?? track.albumId ?? '').trim()
  if (!id) return null
  return {
    id,
    name: track.albumName,
    singer: track.singer,
    source: track.source,
    img: track.img ?? null,
    albumMid: track.albumMid,
  }
}

function App() {
  const [view, setView] = useState<View>('search')
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
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
  const contentScrollRef = useRef<HTMLDivElement>(null)

  const [playlists, setPlaylists] = useState<PlayList[]>(loadPlaylists)
  const [activePlaylistId, setActivePlaylistId] = useState('default')
  const [favoriteAlbums, setFavoriteAlbums] =
    useState<SavedAlbum[]>(loadFavoriteAlbums)
  const [playlistPickerTrack, setPlaylistPickerTrack] =
    useState<MusicTrack | null>(null)
  const [playlistCreateOpen, setPlaylistCreateOpen] = useState(false)
  const [newPlaylistName, setNewPlaylistName] = useState('')
  const [localMusicImporting, setLocalMusicImporting] = useState(false)
  const [legacyDownloads] = useState<LegacyDownloadItem[]>(() =>
    loadJson('one-player:downloads', []),
  )
  const [downloadTasks, setDownloadTasks] = useState<DownloadTask[]>([])
  const downloadTaskKeysRef = useRef(new Set<string>())
  const [downloadedFiles, setDownloadedFiles] = useState<DownloadedAudio[]>([])
  const [downloadToDelete, setDownloadToDelete] =
    useState<DownloadedAudio | null>(null)
  const [downloadDeleteBusy, setDownloadDeleteBusy] = useState(false)
  const [downloadsLoading, setDownloadsLoading] = useState(true)
  const [downloadsError, setDownloadsError] = useState('')
  const [downloadsRefreshToken, setDownloadsRefreshToken] = useState(0)
  const [walkmanDevices, setWalkmanDevices] = useState<WalkmanDevice[]>([])
  const [walkmanError, setWalkmanError] = useState('')
  const [downloadChoice, setDownloadChoice] = useState<{ track?: MusicTrack; album?: AlbumDetail; x: number; y: number } | null>(null)
  const downloadPointerRef = useRef({ x: 600, y: 200 })
  const detectingWalkmanRef = useRef(false)
  async function refreshWalkmanDevices() {
    if (detectingWalkmanRef.current) return
    detectingWalkmanRef.current = true
    try { setWalkmanDevices(await detectWalkman()); setWalkmanError('') }
    catch (error) { setWalkmanDevices([]); setWalkmanError(String(error)) }
    finally { detectingWalkmanRef.current = false }
  }
  useEffect(() => {
    void refreshWalkmanDevices()
    const timer = window.setInterval(() => void refreshWalkmanDevices(), 5000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!downloadChoice) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setDownloadChoice(null) }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [downloadChoice])
  const legacyDownloadsMigratedRef = useRef(false)
  const [queue, setQueue] = useState<MusicTrack[]>([])
  const queueRef = useRef(queue)
  const orderedQueueRef = useRef<MusicTrack[]>([])
  const [playbackMode, setPlaybackMode] =
    useState<PlaybackMode>(loadPlaybackMode)
  const [queueOpen, setQueueOpen] = useState(false)
  const [albumDownloadsInProgress, setAlbumDownloadsInProgress] = useState<
    Set<string>
  >(new Set())
  const [currentTrack, setCurrentTrack] = useState<MusicTrack | null>(null)
  const [currentQuality, setCurrentQuality] = useState<Quality>('320k')
  const [audioUrl, setAudioUrl] = useState('')
  const [isResolving, setIsResolving] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(0.8)
  const [artwork, setArtwork] = useState<string | null>(null)
  const artworkRequestRef = useRef(0)
  const [lyrics, setLyrics] = useState<LyricPayload | null>(null)
  const [lyricsLoading, setLyricsLoading] = useState(false)
  const [lyricsError, setLyricsError] = useState('')
  const lyricRequestRef = useRef(0)
  const [playerOpen, setPlayerOpen] = useState(false)
  const [playerPageMounted, setPlayerPageMounted] = useState(false)
  const [playerPageOrigin, setPlayerPageOrigin] = useState({
    x: 24,
    y: window.innerHeight - 76,
    scale: 0.08,
  })
  const playerAnchorRef = useRef<HTMLButtonElement>(null)
  const playerOpenFrameRef = useRef<number | null>(null)
  const playerCloseTimerRef = useRef<number | null>(null)

  useEffect(() => {
    document.documentElement.classList.toggle('player-page-open', playerPageMounted)
    document.body.classList.toggle('player-page-open', playerPageMounted)

    return () => {
      document.documentElement.classList.remove('player-page-open')
      document.body.classList.remove('player-page-open')
    }
  }, [playerPageMounted])

  useEffect(
    () => () => {
      if (playerOpenFrameRef.current !== null) {
        cancelAnimationFrame(playerOpenFrameRef.current)
      }
      if (playerCloseTimerRef.current !== null) {
        window.clearTimeout(playerCloseTimerRef.current)
      }
    },
    [],
  )

  const updatePlayerPageOrigin = () => {
    const anchorRect = playerAnchorRef.current?.getBoundingClientRect()
    const viewportWidth = document.documentElement.clientWidth
    const viewportHeight = document.documentElement.clientHeight
    if (anchorRect && viewportWidth && viewportHeight) {
      const scale = Math.max(
        Math.min(
          anchorRect.width / viewportWidth,
          anchorRect.height / viewportHeight,
        ),
        0.06,
      )
      setPlayerPageOrigin({
        x: anchorRect.left + (anchorRect.width - viewportWidth * scale) / 2,
        y: anchorRect.top + (anchorRect.height - viewportHeight * scale) / 2,
        scale,
      })
    }
  }

  const openPlayerPage = () => {
    if (!currentTrack) return

    if (playerCloseTimerRef.current !== null) {
      window.clearTimeout(playerCloseTimerRef.current)
      playerCloseTimerRef.current = null
    }

    updatePlayerPageOrigin()

    if (playerPageMounted) {
      setPlayerOpen(true)
      return
    }

    setPlayerPageMounted(true)
    playerOpenFrameRef.current = requestAnimationFrame(() => {
      playerOpenFrameRef.current = requestAnimationFrame(() => {
        setPlayerOpen(true)
        playerOpenFrameRef.current = null
      })
    })
  }

  const closePlayerPage = () => {
    if (playerOpenFrameRef.current !== null) {
      cancelAnimationFrame(playerOpenFrameRef.current)
      playerOpenFrameRef.current = null
    }
    updatePlayerPageOrigin()
    setPlayerOpen(false)
    playerCloseTimerRef.current = window.setTimeout(() => {
      setPlayerPageMounted(false)
      playerCloseTimerRef.current = null
    }, PLAYER_PAGE_TRANSITION_MS)
  }

  const audioRef = useRef<HTMLAudioElement>(null)
  const audioFadeFrameRef = useRef<number | null>(null)
  const audioFadeDirectionRef = useRef<'in' | 'out' | null>(null)
  const volumeRef = useRef(volume)

  function cancelPlaybackFade() {
    if (audioFadeFrameRef.current !== null) {
      cancelAnimationFrame(audioFadeFrameRef.current)
      audioFadeFrameRef.current = null
    }
    audioFadeDirectionRef.current = null
  }

  function fadeAudioVolume(
    targetVolume: number,
    direction: 'in' | 'out',
    onComplete?: () => void,
  ) {
    const audio = audioRef.current
    if (!audio) return

    audioFadeDirectionRef.current = direction
    const startVolume = audio.volume
    const startedAt = performance.now()

    const step = (timestamp: number) => {
      const progress = Math.min(
        (timestamp - startedAt) / PLAYBACK_FADE_MS,
        1,
      )
      audio.volume = Math.min(
        Math.max(startVolume + (targetVolume - startVolume) * progress, 0),
        1,
      )

      if (progress < 1) {
        audioFadeFrameRef.current = requestAnimationFrame(step)
        return
      }

      audioFadeFrameRef.current = null
      audioFadeDirectionRef.current = null
      onComplete?.()
    }

    audioFadeFrameRef.current = requestAnimationFrame(step)
  }

  useEffect(() => cancelPlaybackFade, [])

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
  const showingFavoriteAlbums = activePlaylistId === ALBUM_COLLECTION_ID
  const activePlaylist = showingFavoriteAlbums
    ? null
    : playlists.find((playlist) => playlist.id === activePlaylistId) ?? playlists[0]
  const favoriteTracks = useMemo(
    () => playlists.flatMap((playlist) => playlist.tracks),
    [playlists],
  )
  const currentTrackFavorited =
    currentTrack !== null &&
    favoriteTracks.some((track) => isSameTrack(track, currentTrack))

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
    queueRef.current = queue
  }, [queue])

  useEffect(() => {
    localStorage.setItem(PLAYBACK_MODE_STORAGE_KEY, playbackMode)
  }, [playbackMode])

  useEffect(() => {
    localStorage.setItem('one-player:playlists', JSON.stringify(playlists))
  }, [playlists])

  useEffect(() => {
    const paths = Array.from(
      new Set(
        playlists
          .flatMap((playlist) => playlist.tracks)
          .filter((track) => track.isLocalLibrary && track.filePath)
          .map((track) => track.filePath!),
      ),
    )
    if (!paths.length) return

    let cancelled = false
    void inspectLocalMusicFiles(paths)
      .then((metadata) => {
        if (cancelled || !metadata.length) return
        const tracksByPath = new Map(
          metadata.map((item) => [item.path, localMusicTrack(item)]),
        )
        setPlaylists((current) =>
          current.map((playlist) => ({
            ...playlist,
            tracks: playlist.tracks.map((track) =>
              track.isLocalLibrary &&
              track.filePath &&
              tracksByPath.has(track.filePath)
                ? tracksByPath.get(track.filePath)!
                : track,
            ),
          })),
        )
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(
      FAVORITE_ALBUMS_STORAGE_KEY,
      JSON.stringify(favoriteAlbums),
    )
  }, [favoriteAlbums])

  useEffect(() => {
    let disposed = false
    let stopListening: (() => void) | undefined
    void listen<DownloadProgress>('download-progress', ({ payload }) => {
      if (disposed) return
      setDownloadTasks((items) =>
        items.map((item) =>
          item.id === payload.taskId && item.status === 'downloading'
            ? {
                ...item,
                progress: payload.progress,
                receivedBytes: payload.receivedBytes,
                totalBytes: payload.totalBytes,
              }
            : item,
        ),
      )
    }).then((unlisten) => {
      if (disposed) {
        unlisten()
      } else {
        stopListening = unlisten
      }
    })

    return () => {
      disposed = true
      stopListening?.()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setDownloadsLoading(true)
    listDownloads(settings.downloadDirectory || undefined)
      .then((files) => {
        if (cancelled) return
        setDownloadedFiles(
          [...files].sort((left, right) => right.modifiedAt - left.modifiedAt),
        )
        setDownloadsError('')
      })
      .catch((error) => {
        if (cancelled) return
        setDownloadsError(
          error instanceof Error ? error.message : String(error),
        )
      })
      .finally(() => {
        if (!cancelled) setDownloadsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [downloadsRefreshToken, settings.downloadDirectory])

  useEffect(() => {
    if (legacyDownloadsMigratedRef.current) return
    legacyDownloadsMigratedRef.current = true

    const claimable = legacyDownloads.filter(
      (item) =>
        item.status === 'done' &&
        item.path &&
        /\.(mp3|flac)$/i.test(item.path),
    )

    void (async () => {
      let failedCount = 0
      for (const item of claimable) {
        try {
          await claimDownloadFile({
            path: item.path!,
            proxy: settingsRef.current.proxy || undefined,
            metadata: {
              title: item.track.name,
              artist: item.track.singer,
              album: item.track.albumName,
              coverUrl: item.track.img ?? undefined,
              trackKey: trackDownloadKey(item.track),
            },
          })
        } catch {
          failedCount += 1
        }
      }
      localStorage.removeItem('one-player:downloads')
      if (failedCount) {
        showToast(`${failedCount} 个历史下载文件标记失败`)
      }
      setDownloadsRefreshToken((token) => token + 1)
    })()
  }, [legacyDownloads])

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
    volumeRef.current = volume
    if (audioFadeDirectionRef.current === null && audioRef.current) {
      audioRef.current.volume = volume
    }
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
    setSearchHeroExpanded(false)
    setSearching(true)
    setSearchError('')
    setAlbumDetail(null)
    requestAnimationFrame(() => {
      contentScrollRef.current?.scrollTo({ top: 0 })
    })
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
    const requestId = ++searchRequestRef.current
    setSearching(true)
    setSearchError('')
    try {
      const detail = await getAlbumDetail(album, settingsRef.current)
      if (requestId !== searchRequestRef.current) return
      setAlbumDetail(detail)
      const key = albumCollectionKey(detail.album)
      const savedAlbum = favoriteAlbums.find(
        (item) => albumCollectionKey(item.album) === key,
      )
      if (savedAlbum) {
        setFavoriteAlbums((current) =>
          current.map((item) =>
            albumCollectionKey(item.album) === key
              ? {
                  ...item,
                  album: detail.album,
                  tracks: detail.list,
                }
              : item,
          ),
        )
        if (!savedAlbum.coverDataUrl) {
          void cacheFavoriteAlbumCover(detail.album)
        }
      }
    } catch (error) {
      if (requestId !== searchRequestRef.current) return
      setAlbumDetail(null)
      setSearchError(error instanceof Error ? error.message : String(error))
    } finally {
      if (requestId === searchRequestRef.current) setSearching(false)
    }
  }

  function savedAlbumDetail(savedAlbum: SavedAlbum): AlbumDetail {
    const cover = savedAlbum.coverDataUrl ?? savedAlbum.album.img
    return {
      album: {
        ...savedAlbum.album,
        img: cover ?? null,
      },
      list: savedAlbum.tracks.map((track) => ({
        ...track,
        img: savedAlbum.coverDataUrl ?? track.img,
      })),
    }
  }

  async function cacheFavoriteAlbumCover(album: AlbumSummary) {
    if (!album.img || album.img.startsWith('data:')) return
    try {
      const response = await requestHttp({
        url: album.img,
        proxy: settingsRef.current.proxy || undefined,
        timeoutMs: 20_000,
      })
      if (
        response.statusCode < 200 ||
        response.statusCode >= 300 ||
        !response.rawBase64
      ) {
        return
      }
      const contentType =
        Object.entries(response.headers).find(
          ([key]) => key.toLocaleLowerCase() === 'content-type',
        )?.[1]?.split(';')[0] || 'image/jpeg'
      const coverDataUrl = `data:${contentType};base64,${response.rawBase64}`
      const key = albumCollectionKey(album)
      setFavoriteAlbums((current) =>
        current.map((item) =>
          albumCollectionKey(item.album) === key
            ? { ...item, coverDataUrl }
            : item,
        ),
      )
    } catch {}
  }

  function openFavoriteAlbum(savedAlbum: SavedAlbum) {
    searchRequestRef.current += 1
    const detail = savedAlbumDetail(savedAlbum)
    setView('search')
    setProvider(savedAlbum.album.source)
    setSearchMode('album')
    setQuery(savedAlbum.album.name)
    setSearchedQuery(savedAlbum.album.name)
    setSearchHeroExpanded(false)
    setPage(1)
    setAllPage(1)
    setSearchResults([])
    setAlbumResults([savedAlbum.album])
    setAlbumDetail(savedAlbum.tracks.length ? detail : null)
    setSearchError('')
    setSearching(!savedAlbum.tracks.length)
    requestAnimationFrame(() => {
      contentScrollRef.current?.scrollTo({ top: 0 })
    })
    if (!savedAlbum.tracks.length) {
      void openAlbum(savedAlbum.album)
    }
  }

  async function openTrackAlbum(track: MusicTrack) {
    if (track.source === 'local' || !track.albumName.trim()) {
      showToast('这首歌曲没有可用的在线专辑信息')
      return
    }

    const requestId = ++searchRequestRef.current
    setView('search')
    setProvider(track.source)
    setSearchMode('album')
    setQuery(track.albumName)
    setSearchedQuery(track.albumName)
    setSearchHeroExpanded(false)
    setPage(1)
    setAllPage(1)
    setSearchResults([])
    setAlbumResults([])
    setAlbumDetail(null)
    setSearchError('')
    setSearching(true)
    requestAnimationFrame(() => {
      contentScrollRef.current?.scrollTo({ top: 0 })
    })

    try {
      let album = trackAlbumSummary(track)
      if (!album) {
        const result = await searchAlbums(
          track.source,
          track.albumName,
          1,
          settingsRef.current,
        )
        if (requestId !== searchRequestRef.current) return
        setAlbumResults(result.list)
        setAllPage(result.allPage)
        const normalizedAlbumName = track.albumName.trim().toLocaleLowerCase()
        const normalizedSinger = track.singer.trim().toLocaleLowerCase()
        album =
          result.list.find(
            (item) =>
              item.name.trim().toLocaleLowerCase() === normalizedAlbumName &&
              item.singer.trim().toLocaleLowerCase() === normalizedSinger,
          ) ??
          result.list.find(
            (item) =>
              item.name.trim().toLocaleLowerCase() === normalizedAlbumName,
          ) ??
          result.list[0] ??
          null
      }
      if (!album) throw new Error('没有找到该专辑')

      const detail = await getAlbumDetail(album, settingsRef.current)
      if (requestId !== searchRequestRef.current) return
      setAlbumDetail(detail)
    } catch (error) {
      if (requestId !== searchRequestRef.current) return
      setAlbumDetail(null)
      setSearchError(error instanceof Error ? error.message : String(error))
    } finally {
      if (requestId === searchRequestRef.current) setSearching(false)
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
    setSearchHeroExpanded(true)
    requestAnimationFrame(() => {
      contentScrollRef.current?.scrollTo({ top: 0 })
    })
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

  async function resolveTrackUrl(
    track: MusicTrack,
  ): Promise<{ url: string; quality: Quality }> {
    if (track.isLocalLibrary && track.filePath) {
      const url = await getLocalMusicFileUrl(track.filePath)
      return {
        url,
        quality: track.ext === 'flac' ? 'flac' : '320k',
      }
    }

    if (track.filePath) {
      const url = await getDownloadFileUrl(
        track.filePath,
        settings.downloadDirectory || undefined,
      )
      return {
        url,
        quality: track.ext === 'flac' ? 'flac' : '320k',
      }
    }

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

  async function playTrack(
    track: MusicTrack,
    list: MusicTrack[] = queueRef.current,
    options: {
      canonicalQueue?: MusicTrack[]
      preserveRandomQueue?: boolean
    } = {},
  ) {
    cancelPlaybackFade()
    if (audioRef.current) audioRef.current.volume = volumeRef.current
    const sourceQueue = list.length ? list : [track]
    const canonicalQueue =
      playbackMode === 'random' &&
      options.canonicalQueue === undefined &&
      list === queueRef.current &&
      orderedQueueRef.current.length
        ? orderedQueueRef.current
        : options.canonicalQueue ?? sourceQueue
    const nextQueue =
      playbackMode === 'random' && !options.preserveRandomQueue
        ? createShuffledQueue(canonicalQueue, track)
        : sourceQueue
    setCurrentTrack(track)
    const artworkRequestId = ++artworkRequestRef.current
    setQueue(nextQueue)
    orderedQueueRef.current = canonicalQueue
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
      .then((url) => {
        if (artworkRequestId === artworkRequestRef.current) setArtwork(url)
      })
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

  function playAdjacent(direction: 1 | -1, trigger: 'manual' | 'ended') {
    if (!currentTrack || !queue.length) return
    const index = queue.findIndex((track) => isSameTrack(track, currentTrack))
    const isLast = index === queue.length - 1
    const isFirst = index === 0
    const isBoundary = direction === 1 ? isLast : isFirst

    if (trigger === 'ended' && playbackMode === 'one') {
      void playTrack(currentTrack, queue, {
        canonicalQueue: orderedQueueRef.current,
      })
      return
    }

    if (playbackMode === 'random' && isBoundary) {
      const nextQueue = createShuffledQueue(
        orderedQueueRef.current.length ? orderedQueueRef.current : queue,
        null,
        currentTrack,
      )
      const nextTrack =
        direction === 1
          ? nextQueue[0]
          : nextQueue[nextQueue.length - 1]
      void playTrack(nextTrack, nextQueue, {
        canonicalQueue: orderedQueueRef.current,
        preserveRandomQueue: true,
      })
      return
    }

    if (playbackMode === 'sequence' && isBoundary) {
      return
    }

    const nextIndex = (index + direction + queue.length) % queue.length
    void playTrack(queue[nextIndex], queue, {
      canonicalQueue: orderedQueueRef.current,
      preserveRandomQueue: true,
    })
  }

  function cyclePlaybackMode() {
    const currentIndex = playbackModes.findIndex(
      (mode) => mode.value === playbackMode,
    )
    const nextMode =
      playbackModes[(currentIndex + 1) % playbackModes.length].value

    setPlaybackMode(nextMode)
    if (nextMode === 'random') {
      const canonicalQueue = orderedQueueRef.current.length
        ? orderedQueueRef.current
        : queueRef.current
      setQueue(createShuffledQueue(canonicalQueue, currentTrack))
      return
    }
    if (playbackMode === 'random' && orderedQueueRef.current.length) {
      setQueue(orderedQueueRef.current)
    }
  }

  function togglePlayback() {
    if (!audioRef.current) return

    if (audioFadeDirectionRef.current === 'out') {
      cancelPlaybackFade()
      fadeAudioVolume(volumeRef.current, 'in')
      return
    }

    if (audioFadeDirectionRef.current === 'in') {
      cancelPlaybackFade()
      fadeAudioVolume(0, 'out', () => {
        if (!audioRef.current) return
        audioRef.current.pause()
        audioRef.current.volume = volumeRef.current
      })
      return
    }

    if (audioRef.current.paused) {
      audioRef.current.volume = 0
      void audioRef.current
        .play()
        .then(() => {
          if (audioFadeDirectionRef.current === null) {
            fadeAudioVolume(volumeRef.current, 'in')
          }
        })
        .catch((error) => {
          if (audioRef.current) audioRef.current.volume = volumeRef.current
          showToast(`播放失败：${error instanceof Error ? error.message : String(error)}`)
        })
    } else {
      fadeAudioVolume(0, 'out', () => {
        if (!audioRef.current) return
        audioRef.current.pause()
        audioRef.current.volume = volumeRef.current
      })
    }
  }

  function seekTo(value: number) {
    if (!audioRef.current) return
    audioRef.current.currentTime = value
    setCurrentTime(value)
  }

  function createPlaylist(rawName: string, track?: MusicTrack) {
    const name = rawName.trim()
    if (!name) return false

    if (playlists.some((playlist) => playlist.name === name)) {
      showToast('已存在同名列表')
      return false
    }

    const playlist = {
      id: crypto.randomUUID(),
      name,
      tracks: track ? [track] : [],
      createdAt: Date.now(),
    }
    setPlaylists((current) => [...current, playlist])
    setActivePlaylistId(playlist.id)
    return true
  }

  async function importLocalMusicToPlaylist() {
    if (!activePlaylist || localMusicImporting) return

    try {
      setLocalMusicImporting(true)
      const selection = await open({
        multiple: true,
        directory: false,
        title: '添加本地音乐',
        filters: [{ name: '本地音乐', extensions: LOCAL_AUDIO_EXTENSIONS }],
      })
      const paths = Array.isArray(selection)
        ? selection.filter((path): path is string => typeof path === 'string')
        : typeof selection === 'string'
          ? [selection]
          : []
      if (!paths.length) return

      const metadata = await inspectLocalMusicFiles(paths)
      const localTracks = metadata.map(localMusicTrack)
      const selectedByPath = new Map(
        localTracks.map((track) => [track.filePath, track]),
      )
      const existingPaths = new Set(
        activePlaylist.tracks
          .filter((track) => track.isLocalLibrary)
          .map((track) => track.filePath),
      )
      const additions = localTracks.filter(
        (track) => !existingPaths.has(track.filePath),
      )
      setPlaylists((current) =>
        current.map((playlist) => {
          if (playlist.id !== activePlaylist.id) return playlist
          const refreshedTracks = playlist.tracks.map((track) =>
            track.isLocalLibrary && selectedByPath.has(track.filePath)
              ? selectedByPath.get(track.filePath)!
              : track,
          )
          return {
            ...playlist,
            tracks: [...refreshedTracks, ...additions],
          }
        }),
      )
      showToast(
        additions.length
          ? `已添加 ${additions.length} 首本地音乐`
          : `已刷新 ${localTracks.length} 首本地音乐信息`,
      )
    } catch (error) {
      showToast(
        `添加本地音乐失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    } finally {
      setLocalMusicImporting(false)
    }
  }

  function togglePlaylistTrack(playlistId: string, track: MusicTrack) {
    setPlaylists((current) =>
      current.map((playlist) => {
        if (playlist.id !== playlistId) return playlist
        const exists = playlist.tracks.some((item) => isSameTrack(item, track))
        return {
          ...playlist,
          tracks: exists
            ? playlist.tracks.filter((item) => !isSameTrack(item, track))
            : [track, ...playlist.tracks],
        }
      }),
    )
  }

  function toggleFavoriteAlbum(detail: AlbumDetail) {
    const key = albumCollectionKey(detail.album)
    const exists = favoriteAlbums.some(
      (item) => albumCollectionKey(item.album) === key,
    )
    setFavoriteAlbums((current) =>
      exists
        ? current.filter((item) => albumCollectionKey(item.album) !== key)
        : [
            {
              album: detail.album,
              tracks: detail.list,
              savedAt: Date.now(),
            },
            ...current,
          ],
    )
    showToast(
      exists
        ? `已取消收藏：${detail.album.name}`
        : `已收藏专辑：${detail.album.name}`,
    )
    if (!exists) {
      void cacheFavoriteAlbumCover(detail.album)
      if (settingsRef.current.downloadAlbumsOnFavorite) {
        requestAlbumDownload(detail)
      }
    }
  }

  function getTrackDownloadState(track: MusicTrack): TrackDownloadState {
    const key = trackDownloadKey(track)
    const task = downloadTasks.find(
      (item) => item.trackKey === key && item.status === 'downloading',
    )
    if (task) {
      return { status: 'downloading', progress: task.progress }
    }
    if (isTrackDownloaded(track, downloadedFiles)) {
      return { status: 'done', progress: 100, canChooseDestination: walkmanDevices.length > 0 }
    }
    return { status: 'idle', progress: null }
  }

  function requestTrackDownload(track: MusicTrack) {
    if (walkmanDevices.length) setDownloadChoice({ track, ...downloadPointerRef.current })
    else void downloadTrack(track)
  }

  function requestAlbumDownload(album: AlbumDetail) {
    if (walkmanDevices.length) setDownloadChoice({ album, ...downloadPointerRef.current })
    else void downloadAlbumTracks(album)
  }

  function startChosenDownload(walkmanId?: string) {
    const choice = downloadChoice
    setDownloadChoice(null)
    if (choice?.track) void downloadTrack(choice.track, { walkmanId })
    if (choice?.album) void downloadAlbumTracks(choice.album, walkmanId)
  }

  async function downloadTrack(
    track: MusicTrack,
    options: DownloadTrackOptions = {},
  ): Promise<DownloadOutcome> {
    const trackKey = trackDownloadKey(track)
    const taskKey = `${options.walkmanId ?? 'downloads'}:${trackKey}`
    if (downloadTaskKeysRef.current.has(taskKey)) return 'skipped'
    if (!options.walkmanId && isTrackDownloaded(track, downloadedFiles)) {
      if (!options.silent) showToast(`已下载：${track.name}`)
      return 'skipped'
    }

    const downloadId = crypto.randomUUID()
    downloadTaskKeysRef.current.add(taskKey)
    setDownloadTasks((items) => [
      {
        id: downloadId,
        trackKey,
        destination: options.walkmanId ? walkmanDevices.find(d => d.id === options.walkmanId)?.name ?? 'WALKMAN' : '下载文件夹',
        track,
        quality: settingsRef.current.playQuality,
        status: 'downloading',
        progress: 0,
        receivedBytes: 0,
        totalBytes: null,
        createdAt: Date.now(),
      },
      ...items.filter((item) => item.trackKey !== trackKey),
    ])
    try {
      const currentSettings = settingsRef.current
      const existing = options.walkmanId ? downloadedFiles.find(file => isTrackDownloaded(track, [file])) : undefined
      if (existing && options.walkmanId) {
        await transferWalkmanFile(options.walkmanId, existing.path, true, currentSettings.downloadDirectory || undefined)
        setDownloadTasks(items => items.filter(item => item.id !== downloadId))
        if (!options.silent) showToast(`已同步到 WALKMAN：${track.name}`)
        return 'downloaded'
      }
      const { url, quality } = await resolveTrackUrl(track)
      setDownloadTasks((items) =>
        items.map((item) =>
          item.id === downloadId ? { ...item, quality } : item,
        ),
      )
      const extension = quality === 'flac' || quality === 'flac24bit' ? 'flac' : 'mp3'
      const fileName = `${sanitizeFileName(`${track.singer} - ${track.name}`)}.${extension}`
      const coverUrl = await getBuiltinArtwork(track, currentSettings).catch(
        () => null,
      )
      const downloaded = await downloadFile({
        taskId: downloadId,
        walkmanId: options.walkmanId,
        url,
        directory: currentSettings.downloadDirectory || undefined,
        fileName,
        proxy: currentSettings.proxy || undefined,
        metadata: {
          title: track.name,
          artist: track.singer,
          album: track.albumName,
          coverUrl: coverUrl ?? undefined,
          trackKey,
        },
      })
      if (!options.walkmanId) setDownloadedFiles((files) =>
        [downloaded, ...files.filter((file) => file.path !== downloaded.path)].sort(
          (left, right) => right.modifiedAt - left.modifiedAt,
        ),
      )
      setDownloadTasks((items) => items.filter((item) => item.id !== downloadId))
      if (!options.silent) showToast(`已下载到${options.walkmanId ? ' WALKMAN' : '下载文件夹'}：${fileName}`)
      return 'downloaded'
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setDownloadTasks((items) =>
        items.map((item) =>
          item.id === downloadId ? { ...item, status: 'error', message } : item,
        ),
      )
      if (!options.silent) showToast(`下载失败：${message}`)
      return 'failed'
    } finally {
      downloadTaskKeysRef.current.delete(taskKey)
      setDownloadsRefreshToken((token) => token + 1)
      void refreshWalkmanDevices()
    }
  }

  async function downloadAlbumTracks(detail: AlbumDetail, walkmanId?: string) {
    const albumKey = albumCollectionKey(detail.album)
    if (albumDownloadsInProgress.has(albumKey)) return
    const pendingTracks = detail.list.filter(
      (track) =>
        (walkmanId || !isTrackDownloaded(track, downloadedFiles)) &&
        !downloadTaskKeysRef.current.has(`${walkmanId ?? 'downloads'}:${trackDownloadKey(track)}`),
    )
    if (!pendingTracks.length) {
      showToast('专辑歌曲均已下载或正在下载')
      return
    }

    setAlbumDownloadsInProgress((current) => {
      const next = new Set(current)
      next.add(albumKey)
      return next
    })
    showToast(`开始下载《${detail.album.name}》剩余 ${pendingTracks.length} 首歌曲`)

    let nextTrackIndex = 0
    let downloadedCount = 0
    let failedCount = 0
    const worker = async () => {
      while (nextTrackIndex < pendingTracks.length) {
        const track = pendingTracks[nextTrackIndex]
        nextTrackIndex += 1
        const outcome = await downloadTrack(track, { silent: true, walkmanId })
        if (outcome === 'downloaded') downloadedCount += 1
        if (outcome === 'failed') failedCount += 1
      }
    }

    try {
      await Promise.all(
        Array.from(
          { length: Math.min(3, pendingTracks.length) },
          () => worker(),
        ),
      )
      showToast(
        failedCount
          ? `专辑下载完成：成功 ${downloadedCount} 首，失败 ${failedCount} 首`
          : `专辑下载完成：${downloadedCount} 首`,
      )
    } finally {
      setAlbumDownloadsInProgress((current) => {
        const next = new Set(current)
        next.delete(albumKey)
        return next
      })
    }
  }

  async function confirmDeleteDownload() {
    if (!downloadToDelete || downloadDeleteBusy) return

    setDownloadDeleteBusy(true)
    try {
      await deleteDownload(
        downloadToDelete.path,
        settings.downloadDirectory || undefined,
      )
      const deletedPath = downloadToDelete.path
      setDownloadedFiles((files) => files.filter((file) => file.path !== deletedPath))
      if (currentTrack?.filePath === deletedPath) {
        cancelPlaybackFade()
        audioRef.current?.pause()
        if (audioRef.current) {
          audioRef.current.removeAttribute('src')
          audioRef.current.load()
        }
        setCurrentTrack(null)
        setQueue([])
        queueRef.current = []
        orderedQueueRef.current = []
        setAudioUrl('')
        setIsPlaying(false)
      } else {
        const remainingQueue = queue.filter(
          (item) => item.filePath !== deletedPath,
        )
        setQueue(remainingQueue)
        queueRef.current = remainingQueue
        orderedQueueRef.current = orderedQueueRef.current.filter(
          (item) => item.filePath !== deletedPath,
        )
      }
      setDownloadToDelete(null)
      showToast(`已删除：${downloadToDelete.title}`)
    } catch (error) {
      showToast(`删除失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setDownloadDeleteBusy(false)
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
    <div className="app-shell" onPointerDownCapture={event => { downloadPointerRef.current = { x: event.clientX, y: event.clientY } }}>
      <audio
        ref={audioRef}
        src={audioUrl}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onDurationChange={(event) => setDuration(event.currentTarget.duration || 0)}
        onEnded={() => playAdjacent(1, 'ended')}
      />

      <div
        className={`window-controls ${playerOpen ? 'player-open' : ''}`}
        aria-label="窗口控制"
      >
        {playerOpen && currentTrack && (
          <button
            className="player-collapse-control"
            onClick={closePlayerPage}
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
                {item.id === 'library' && favoriteTracks.length > 0 && (
                  <em>{favoriteTracks.length}</em>
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
            {view === 'walkman' && 'WALKMAN 音乐管理'}
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
          ref={contentScrollRef}
          className="content-scroll"
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
              favorites={favoriteTracks}
              favoriteAlbums={favoriteAlbums}
              albumDownloadBusy={
                albumDetail
                  ? albumDownloadsInProgress.has(
                      albumCollectionKey(albumDetail.album),
                    )
                  : false
              }
              searchedQuery={searchedQuery}
              heroExpanded={searchHeroExpanded}
              page={page}
              allPage={allPage}
              onSearch={handleSearch}
              onOpenAlbum={(album) => void openAlbum(album)}
              onOpenTrackAlbum={(track) => void openTrackAlbum(track)}
              onToggleAlbumFavorite={toggleFavoriteAlbum}
              onDownloadAlbum={requestAlbumDownload}
              canChooseDownloadDestination={walkmanDevices.length > 0}
              onCloseAlbum={() => {
                setAlbumDetail(null)
                setSearchError('')
              }}
              onPlay={(track, list) => void playTrack(track, list)}
              onFavorite={setPlaylistPickerTrack}
              onDownload={requestTrackDownload}
              getDownloadState={getTrackDownloadState}
            />
          )}

          {view === 'library' && (
            <section className="page-section">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">COLLECTION</span>
                  <h1>我的列表</h1>
                  <p>
                    {showingFavoriteAlbums
                      ? '收藏的专辑会保存在本机，不会上传。'
                      : '收藏的歌曲会保存在本机，不会上传。'}
                  </p>
                </div>
                <div className="library-heading-actions">
                  {!showingFavoriteAlbums && activePlaylist && (
                    <button
                      className="secondary-button library-local-button"
                      onClick={() => void importLocalMusicToPlaylist()}
                      disabled={localMusicImporting}
                    >
                      <FolderOpen size={15} />
                      {localMusicImporting ? '添加中…' : '添加本地音乐'}
                    </button>
                  )}
                  <div className="summary-chip">
                    {showingFavoriteAlbums ? (
                      <>
                        <Disc3 size={18} />
                        {favoriteAlbums.length} 张专辑
                      </>
                    ) : (
                      <>
                        <ListMusic size={18} />
                        {playlists.length} 个列表 · {favoriteTracks.length} 首
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="playlist-tabs">
                {playlists.map((playlist) => (
                  <button
                    key={playlist.id}
                    className={playlist.id === activePlaylist?.id ? 'active' : ''}
                    onClick={() => setActivePlaylistId(playlist.id)}
                  >
                    {playlist.name}
                    <span>{playlist.tracks.length}</span>
                  </button>
                ))}
                <button
                  className={`album-collection-tab ${
                    showingFavoriteAlbums ? 'active' : ''
                  }`}
                  onClick={() => setActivePlaylistId(ALBUM_COLLECTION_ID)}
                >
                  <Disc3 size={15} />
                  专辑收藏
                  <span>{favoriteAlbums.length}</span>
                </button>
                <button
                  className="playlist-create"
                  onClick={() => {
                    setNewPlaylistName('')
                    setPlaylistCreateOpen(true)
                  }}
                >
                  <Plus size={15} />
                  新建
                </button>
              </div>
              {showingFavoriteAlbums ? (
                favoriteAlbums.length ? (
                  <div className="album-grid library-album-grid">
                    {favoriteAlbums.map((savedAlbum) => {
                      const album = savedAlbum.album
                      const cover = savedAlbum.coverDataUrl ?? album.img
                      return (
                        <button
                          className="album-card"
                          key={albumCollectionKey(album)}
                          onClick={() => openFavoriteAlbum(savedAlbum)}
                        >
                          <div className="album-card-cover">
                            {cover ? (
                              <img
                                src={cover}
                                alt=""
                                referrerPolicy="no-referrer"
                              />
                            ) : (
                              <Music2 size={25} />
                            )}
                          </div>
                          <div className="album-card-info">
                            <strong>{album.name}</strong>
                            <span>{album.singer || '未知歌手'}</span>
                            <small>
                              {[
                                album.publishTime,
                                album.songCount && `${album.songCount} 首`,
                              ]
                                .filter(Boolean)
                                .join(' · ') || providerNames[album.source]}
                            </small>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <EmptyState
                    icon={<Disc3 size={30} />}
                    title="还没有收藏专辑"
                    description="进入专辑详情后，点击头部的收藏按钮即可保存整张专辑。"
                    action="去搜索专辑"
                    onAction={() => {
                      setView('search')
                      setSearchMode('album')
                    }}
                  />
                )
              ) : activePlaylist?.tracks.length ? (
                <TrackTable
                  tracks={activePlaylist.tracks}
                  favorites={favoriteTracks}
                  capabilities={sourceStatus.capabilities}
                  playQuality={settings.playQuality}
                  onPlay={(track) => void playTrack(track, activePlaylist.tracks)}
                  onFavorite={setPlaylistPickerTrack}
                  onDownload={requestTrackDownload}
                  getDownloadState={getTrackDownloadState}
                  onOpenAlbum={(track) => void openTrackAlbum(track)}
                />
              ) : (
                <EmptyState
                  icon={<Heart size={30} />}
                  title={`「${activePlaylist?.name ?? '我的收藏'}」还是空的`}
                  description="在搜索结果中点击心形按钮，选择要加入的列表。"
                  action="添加本地音乐"
                  onAction={() => void importLocalMusicToPlaylist()}
                />
              )}
            </section>
          )}

          {view === 'downloads' && (
            <DownloadsView
              onOpenWalkman={() => setView('walkman')}
              walkmanDevices={walkmanDevices}
              tasks={downloadTasks}
              files={downloadedFiles}
              loading={downloadsLoading}
              error={downloadsError}
              deleteBusy={downloadDeleteBusy}
              onPlay={(track) =>
                void playTrack(
                  track,
                  downloadedFiles.map((file) => downloadedAudioTrack(file)),
                )
              }
              onDelete={(file) => setDownloadToDelete(file)}
            />
          )}

          {view === 'walkman' && <WalkmanPage devices={walkmanDevices} deviceError={walkmanError} downloads={downloadedFiles} settings={settings} onBack={() => setView('downloads')} onRefreshDevices={refreshWalkmanDevices} onDownloadsChanged={() => setDownloadsRefreshToken(token => token + 1)} />}

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
        anchorRef={playerAnchorRef}
        track={currentTrack}
        artwork={artwork}
        quality={currentQuality}
        isPlaying={isPlaying}
        isResolving={isResolving}
        currentTime={currentTime}
        duration={duration}
        volume={volume}
        isFavorite={currentTrackFavorited}
        onVolume={setVolume}
        onFavorite={() => {
          if (currentTrack) setPlaylistPickerTrack(currentTrack)
        }}
        downloadState={
          currentTrack ? getTrackDownloadState(currentTrack) : undefined
        }
        onDownload={() => {
          if (currentTrack) requestTrackDownload(currentTrack)
        }}
        onToggle={togglePlayback}
        onPrevious={() => playAdjacent(-1, 'manual')}
        onNext={() => playAdjacent(1, 'manual')}
        playbackMode={playbackMode}
        onPlaybackMode={cyclePlaybackMode}
        onQueue={() => setQueueOpen(true)}
        onSeek={seekTo}
        onOpen={openPlayerPage}
      />

      {playerPageMounted && currentTrack && (
        <PlayerPage
          open={playerOpen}
          origin={playerPageOrigin}
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
          isFavorite={currentTrackFavorited}
          downloadState={getTrackDownloadState(currentTrack)}
          onDownload={() => requestTrackDownload(currentTrack)}
          onFavorite={() => setPlaylistPickerTrack(currentTrack)}
          onToggle={togglePlayback}
          onPrevious={() => playAdjacent(-1, 'manual')}
          onNext={() => playAdjacent(1, 'manual')}
          playbackMode={playbackMode}
          onPlaybackMode={cyclePlaybackMode}
          onQueue={() => setQueueOpen(true)}
          onSeek={seekTo}
          onOpenAlbum={() => {
            closePlayerPage()
            void openTrackAlbum(currentTrack)
          }}
          onClosed={() => {
            if (!playerOpen) setPlayerPageMounted(false)
          }}
        />
      )}

      {queueOpen && currentTrack && (
        <QueuePanel
          queue={queue.length ? queue : [currentTrack]}
          currentTrack={currentTrack}
          onSelect={(track) =>
            void playTrack(track, queue.length ? queue : [currentTrack])
          }
          onClose={() => setQueueOpen(false)}
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

      {playlistPickerTrack && (
        <PlaylistPicker
          key={`${playlistPickerTrack.source}_${playlistPickerTrack.id}`}
          track={playlistPickerTrack}
          playlists={playlists}
          onToggle={(playlistId) =>
            togglePlaylistTrack(playlistId, playlistPickerTrack)
          }
          onCreate={createPlaylist}
          onClose={() => setPlaylistPickerTrack(null)}
        />
      )}

      {playlistCreateOpen && (
        <div className="modal-backdrop" onClick={() => setPlaylistCreateOpen(false)}>
          <form
            className="modal-card playlist-create-modal"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault()
              if (createPlaylist(newPlaylistName)) {
                setPlaylistCreateOpen(false)
              }
            }}
          >
            <button
              type="button"
              className="modal-close"
              onClick={() => setPlaylistCreateOpen(false)}
              aria-label="取消新建列表"
            >
              <X size={18} />
            </button>
            <div className="modal-icon">
              <ListMusic size={22} />
            </div>
            <h2>新建列表</h2>
            <input
              className="setting-input modal-input"
              value={newPlaylistName}
              onChange={(event) => setNewPlaylistName(event.target.value)}
              placeholder="列表名称"
              maxLength={30}
              autoFocus
            />
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setPlaylistCreateOpen(false)}
              >
                取消
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={!newPlaylistName.trim()}
              >
                新建
              </button>
            </div>
          </form>
        </div>
      )}

      {downloadChoice && <div className="download-destination-backdrop" onClick={() => setDownloadChoice(null)}><div className="download-destination-menu" role="menu" aria-label="选择下载位置" style={{ left: Math.max(12, Math.min(downloadChoice.x - 220, window.innerWidth - 300)), top: Math.max(12, Math.min(downloadChoice.y + 10, window.innerHeight - 220)) }} onClick={event => event.stopPropagation()}><strong>下载到</strong><button role="menuitem" autoFocus onClick={() => startChosenDownload()}><HardDrive size={19} /><span>下载文件夹<small>保存到电脑，纳入下载管理</small></span></button>{walkmanDevices.map(device => <button role="menuitem" key={device.id} onClick={() => startChosenDownload(device.id)}><Usb size={19} /><span>{device.name}<small>直接保存到 MUSIC · {Math.round(device.freeBytes / 1024 ** 3 * 10) / 10} GB 可用</small></span></button>)}</div></div>}

      {downloadToDelete && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!downloadDeleteBusy) setDownloadToDelete(null)
          }}
        >
          <div
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="modal-close"
              onClick={() => setDownloadToDelete(null)}
              disabled={downloadDeleteBusy}
              aria-label="取消删除"
            >
              <X size={18} />
            </button>
            <div className="modal-icon danger">
              <Trash2 size={22} />
            </div>
            <h2>删除下载文件</h2>
            <p className="modal-source">
              将从磁盘中删除「{downloadToDelete.title}」，此操作不可恢复。
            </p>
            <div className="modal-actions">
              <button
                className="secondary-button"
                onClick={() => setDownloadToDelete(null)}
                disabled={downloadDeleteBusy}
              >
                取消
              </button>
              <button
                className="primary-button danger"
                onClick={() => void confirmDeleteDownload()}
                disabled={downloadDeleteBusy}
              >
                {downloadDeleteBusy ? '删除中…' : '删除'}
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
  canChooseDownloadDestination: boolean
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
  favoriteAlbums: SavedAlbum[]
  albumDownloadBusy: boolean
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
  onOpenTrackAlbum: (track: MusicTrack) => void
  onToggleAlbumFavorite: (detail: AlbumDetail) => void
  onDownloadAlbum: (detail: AlbumDetail) => void
  onCloseAlbum: () => void
  onPlay: (track: MusicTrack, list: MusicTrack[]) => void
  onFavorite: (track: MusicTrack) => void
  onDownload: (track: MusicTrack) => void
  getDownloadState: (track: MusicTrack) => TrackDownloadState
}

function SearchView(props: SearchViewProps) {
  const detailTracks = props.albumDetail?.list ?? []
  const isAlbumMode = props.searchMode === 'album'
  const albumFavorited =
    props.albumDetail !== null &&
    props.favoriteAlbums.some(
      (savedAlbum) =>
        albumCollectionKey(savedAlbum.album) ===
        albumCollectionKey(props.albumDetail!.album),
    )
  const albumHasPendingDownloads = props.canChooseDownloadDestination || detailTracks.some(
    (track) => props.getDownloadState(track).status !== 'done',
  )
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
              <div className="album-detail-actions">
                <button
                  className={`secondary-button album-favorite-button ${
                    albumFavorited ? 'active' : ''
                  }`}
                  onClick={() =>
                    props.onToggleAlbumFavorite(props.albumDetail!)
                  }
                >
                  <Heart
                    size={16}
                    fill={albumFavorited ? 'currentColor' : 'none'}
                  />
                  {albumFavorited ? '已收藏' : '收藏'}
                </button>
                {albumHasPendingDownloads && (
                  <button
                    className="secondary-button album-download-button"
                    disabled={props.albumDownloadBusy}
                    onClick={() => props.onDownloadAlbum(props.albumDetail!)}
                  >
                    {props.albumDownloadBusy ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <Download size={16} />
                    )}
                    {props.albumDownloadBusy ? '下载中' : '下载全部'}
                  </button>
                )}
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
            </div>
            <TrackTable
              tracks={detailTracks}
              favorites={props.favorites}
              capabilities={props.capabilities}
              playQuality={props.playQuality}
              onPlay={(track) => props.onPlay(track, detailTracks)}
              onFavorite={props.onFavorite}
              onDownload={props.onDownload}
              getDownloadState={props.getDownloadState}
              onOpenAlbum={props.onOpenTrackAlbum}
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
            getDownloadState={props.getDownloadState}
            onOpenAlbum={props.onOpenTrackAlbum}
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
  getDownloadState: (track: MusicTrack) => TrackDownloadState
  onOpenAlbum: (track: MusicTrack) => void
}

function TrackTable({
  tracks,
  favorites,
  capabilities,
  playQuality,
  onPlay,
  onFavorite,
  onDownload,
  getDownloadState,
  onOpenAlbum,
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
        const liked = favorites.some((item) => isSameTrack(item, track))
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
        const downloadState = getDownloadState(track)
        return (
          <div
            className={`track-row download-${downloadState.status}`}
            key={`${track.id}-${index}`}
          >
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
            <button
              className="track-album"
              title={track.albumName}
              disabled={!track.albumName || track.source === 'local'}
              onClick={() => onOpenAlbum(track)}
            >
              {track.albumName || '—'}
            </button>
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
              <button
                className={`download-action ${downloadState.status}`}
                aria-label={
                  downloadState.status === 'downloading'
                    ? `下载中 ${downloadState.progress ?? 0}%`
                    : downloadState.status === 'done'
                      ? '已下载'
                      : '下载'
                }
                title={
                  downloadState.status === 'downloading'
                    ? `下载中 ${downloadState.progress ?? 0}%`
                    : downloadState.status === 'done'
                      ? '已下载'
                      : '下载'
                }
                disabled={downloadState.status === 'downloading' || (downloadState.status === 'done' && !downloadState.canChooseDestination)}
                onClick={() => onDownload(track)}
              >
                {downloadState.status === 'downloading' ? (
                  <CircularProgress
                    progress={downloadState.progress}
                    compact
                  />
                ) : downloadState.status === 'done' ? (
                  <Check size={17} />
                ) : (
                  <Download size={17} />
                )}
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

function CircularProgress({
  progress,
  compact = false,
}: {
  progress: number | null
  compact?: boolean
}) {
  const value =
    progress === null ? null : Math.min(Math.max(Math.round(progress), 0), 100)
  return (
    <span
      className={`circular-progress ${compact ? 'compact' : ''} ${
        value === null ? 'indeterminate' : ''
      }`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 28 28">
        <circle className="circular-progress-track" cx="14" cy="14" r="11" />
        <circle
          className="circular-progress-value"
          cx="14"
          cy="14"
          r="11"
          pathLength="100"
          strokeDasharray="100"
          strokeDashoffset={value === null ? 72 : 100 - value}
        />
      </svg>
      <span>{value === null ? '…' : compact ? value : `${value}%`}</span>
    </span>
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

interface PlaylistPickerProps {
  track: MusicTrack
  playlists: PlayList[]
  onToggle: (playlistId: string) => void
  onCreate: (name: string, track: MusicTrack) => void
  onClose: () => void
}

function PlaylistPicker(props: PlaylistPickerProps) {
  const [newPlaylistName, setNewPlaylistName] = useState('')

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div
        className="modal-card playlist-picker"
        onClick={(event) => event.stopPropagation()}
      >
        <button className="modal-close" onClick={props.onClose}>
          <X size={18} />
        </button>
        <div className="modal-icon">
          <Heart size={22} />
        </div>
        <h2>加入列表</h2>
        <p className="playlist-picker-track">
          {props.track.name} · {props.track.singer}
        </p>
        <div className="playlist-picker-list">
          {props.playlists.map((playlist) => {
            const selected = playlist.tracks.some(
              (item) => item.id === props.track.id,
            )
            return (
              <button
                key={playlist.id}
                className={selected ? 'selected' : ''}
                role="checkbox"
                aria-checked={selected}
                onClick={() => props.onToggle(playlist.id)}
              >
                <span>{playlist.name}</span>
                <small>{playlist.tracks.length} 首</small>
              </button>
            )
          })}
        </div>
        <form
          className="playlist-create-form"
          onSubmit={(event) => {
            event.preventDefault()
            props.onCreate(newPlaylistName, props.track)
            setNewPlaylistName('')
          }}
        >
          <input
            value={newPlaylistName}
            onChange={(event) => setNewPlaylistName(event.target.value)}
            placeholder="新建列表名称"
            maxLength={30}
          />
          <button type="submit" disabled={!newPlaylistName.trim()}>
            <Plus size={15} />
            新建
          </button>
        </form>
      </div>
    </div>
  )
}

interface DownloadsViewProps {
  onOpenWalkman: () => void
  walkmanDevices: WalkmanDevice[]
  tasks: DownloadTask[]
  files: DownloadedAudio[]
  loading: boolean
  error: string
  deleteBusy: boolean
  onPlay: (track: MusicTrack) => void
  onDelete: (file: DownloadedAudio) => void
}

const downloadedAudioTrack = (file: DownloadedAudio): MusicTrack => ({
  id: file.path,
  name: file.title,
  singer: file.artist || '未知艺术家',
  source: 'local',
  songmid: '',
  interval: null,
  albumName: file.album,
  img: file.coverDataUrl ?? null,
  filePath: file.path,
  ext: file.format,
  types: [{ type: file.format === 'flac' ? 'flac' : '320k', size: null }],
  _types: file.format === 'flac' ? { flac: { size: null } } : { '320k': { size: null } },
  typeUrl: {},
})

const formatFileSize = (bytes: number) => {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }
  return `${Math.max(Math.round(bytes / 1024), 1)} KB`
}

function DownloadsView(props: DownloadsViewProps) {
  const activeDownloads = props.tasks.filter(
    (item) => item.status === 'downloading',
  ).length
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
          {props.files.length} 个文件
          {activeDownloads ? ` · ${activeDownloads} 个下载中` : ''}
        </div>
      </div>
      <button className="walkman-entry" onClick={props.onOpenWalkman}><span className="walkman-entry-icon"><Usb size={25} /></span><span><strong>WALKMAN 音乐管理</strong><small>{props.walkmanDevices.length ? `已连接 ${props.walkmanDevices.map(device => device.name).join('、')} · 选择音乐同步或补全标签` : '连接随身听，同步音乐、补全标签并查看存储空间'}</small></span><ChevronRight size={21} /></button>
      {props.error && (
        <p className="download-error">{props.error}</p>
      )}
      {props.tasks.length || props.files.length ? (
        <div className="download-list">
          {props.tasks.map((item) => (
            <div className="download-row" key={item.id}>
              <Artwork track={item.track} size="small" />
              <div className="download-info">
                <strong>{item.track.name}</strong>
                <span>
                  {item.track.singer} · {item.track.albumName || '未知专辑'} ·{' '}
                  {qualityNames[item.quality]} · {item.destination || '下载文件夹'}
                </span>
              </div>
              <div className={`download-status ${item.status}`}>
                {item.status === 'downloading' && (
                  <>
                    <CircularProgress progress={item.progress} />
                    <span>
                      {item.progress !== null && item.progress >= 98
                        ? '正在写入标签'
                        : '下载中'}
                    </span>
                  </>
                )}
                {item.status === 'error' && (
                  <>
                    <CircleAlert size={16} />
                    {item.message ?? '下载失败'}
                  </>
                )}
              </div>
              <span className="download-path">
                {item.status === 'downloading'
                  ? item.totalBytes
                    ? `${formatFileSize(item.receivedBytes)} / ${formatFileSize(item.totalBytes)}`
                    : item.receivedBytes
                      ? `已接收 ${formatFileSize(item.receivedBytes)}`
                      : '正在准备下载'
                  : '未完成'}
              </span>
            </div>
          ))}
          {props.files.map((file) => (
            <div className="download-row" key={file.path}>
              <button
                className="download-play"
                onClick={() => props.onPlay(downloadedAudioTrack(file))}
                aria-label={`播放 ${file.title}`}
              >
                <Artwork
                  track={downloadedAudioTrack(file)}
                  url={file.coverDataUrl}
                  size="small"
                />
                <span className="download-info">
                  <strong>{file.title}</strong>
                  <span>
                    {file.artist || '未知艺术家'} ·{' '}
                    {file.album || '未知专辑'} · {file.format.toUpperCase()}{file.importSource && <span className="download-origin">{file.importSource} 导入</span>}
                  </span>
                </span>
              </button>
              <div className="download-status done">
                <span className="done-dot" />
                {formatFileSize(file.size)}
              </div>
              <span className="download-path" title={file.path}>
                {file.path}
              </span>
              <button
                className="download-delete"
                onClick={() => props.onDelete(file)}
                disabled={props.deleteBusy}
                aria-label={`删除 ${file.title}`}
                title="删除下载文件"
              >
                <Trash2 size={17} />
              </button>
            </div>
          ))}
        </div>
      ) : props.loading ? (
        <EmptyState
          icon={<LoaderCircle className="spin" size={30} />}
          title="正在读取下载目录"
          description="扫描由 One Player 下载并标记的音频文件。"
        />
      ) : (
        <EmptyState
          icon={<Download size={30} />}
          title="还没有 One Player 下载文件"
          description="从搜索结果或我的列表中点击下载按钮，下载页会展示目录中的历史文件。"
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
          <SettingRow
            label="收藏专辑时保存到本地"
            description="开启后，收藏专辑会自动下载其中尚未保存的歌曲"
          >
            <label className="switch" title="收藏专辑时保存全部歌曲到下载目录">
              <input
                type="checkbox"
                checked={props.settings.downloadAlbumsOnFavorite}
                onChange={(event) =>
                  props.setSettings((current) => ({
                    ...current,
                    downloadAlbumsOnFavorite: event.target.checked,
                  }))
                }
              />
              <span />
            </label>
          </SettingRow>
          <SettingRow
            label="补全标签时覆盖原值"
            description="关闭后，仅填入文件中缺失的标签；弹窗内仍可手动改用新值"
          >
            <label className="switch" title="选择搜索结果时是否覆盖已有标签">
              <input
                type="checkbox"
                checked={props.settings.overwriteExistingTags}
                onChange={(event) =>
                  props.setSettings((current) => ({
                    ...current,
                    overwriteExistingTags: event.target.checked,
                  }))
                }
              />
              <span />
            </label>
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

interface QueuePanelProps {
  queue: MusicTrack[]
  currentTrack: MusicTrack
  onSelect: (track: MusicTrack) => void
  onClose: () => void
}

function QueuePanel(props: QueuePanelProps) {
  const currentItemRef = useRef<HTMLButtonElement>(null)
  const currentIndex = props.queue.findIndex((track) =>
    isSameTrack(track, props.currentTrack),
  )

  useEffect(() => {
    currentItemRef.current?.scrollIntoView({ block: 'center' })
  }, [currentIndex])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [props.onClose])

  return (
    <div className="queue-backdrop" onClick={props.onClose}>
      <aside
        className="queue-panel"
        aria-label="当前播放列表"
        aria-modal="true"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="queue-panel-header">
          <div>
            <span className="eyebrow">UP NEXT</span>
            <h2>播放列表</h2>
            <p>
              当前第 {Math.max(currentIndex + 1, 1)} 首，共 {props.queue.length} 首
            </p>
          </div>
          <button onClick={props.onClose} aria-label="关闭播放列表">
            <X size={18} />
          </button>
        </div>
        <div className="queue-list">
          {props.queue.map((track, index) => {
            const current = isSameTrack(track, props.currentTrack)
            return (
              <button
                ref={current ? currentItemRef : undefined}
                className={`queue-item ${current ? 'current' : ''}`}
                key={`${track.source}-${track.id}-${index}`}
                onClick={() => props.onSelect(track)}
              >
                <span className="queue-item-index">
                  {current ? (
                    <Volume2 size={15} />
                  ) : (
                    (index + 1).toString().padStart(2, '0')
                  )}
                </span>
                <Artwork track={track} size="small" />
                <span className="queue-item-main">
                  <strong>{track.name}</strong>
                  <small>
                    {track.singer || '未知歌手'}
                    {track.albumName ? ` · ${track.albumName}` : ''}
                  </small>
                </span>
                <span className="queue-item-duration">
                  {track.interval ?? '—'}
                </span>
              </button>
            )
          })}
        </div>
      </aside>
    </div>
  )
}

interface PlayerBarProps {
  anchorRef: RefObject<HTMLButtonElement | null>
  track: MusicTrack | null
  artwork: string | null
  quality: Quality
  isPlaying: boolean
  isResolving: boolean
  currentTime: number
  duration: number
  volume: number
  isFavorite: boolean
  downloadState?: TrackDownloadState
  onDownload: () => void
  onVolume: (value: number) => void
  onFavorite: () => void
  onToggle: () => void
  onPrevious: () => void
  onNext: () => void
  playbackMode: PlaybackMode
  onPlaybackMode: () => void
  onQueue: () => void
  onSeek: (value: number) => void
  onOpen: () => void
}

function PlaybackDownloadButton({
  state,
  size,
  onDownload,
  disabled = false,
}: {
  state: TrackDownloadState
  size: number
  onDownload: () => void
  disabled?: boolean
}) {
  const label =
    state.status === 'downloading'
      ? `下载中 ${state.progress ?? 0}%`
      : state.status === 'done'
        ? '已下载'
        : '下载'
  return (
    <button
      className={`download-control ${state.status}`}
      onClick={onDownload}
      disabled={disabled || state.status === 'downloading' || (state.status === 'done' && !state.canChooseDestination)}
      aria-label={label}
      title={label}
    >
      {state.status === 'downloading' ? (
        <CircularProgress progress={state.progress} compact />
      ) : state.status === 'done' ? (
        <Check size={size} />
      ) : (
        <Download size={size} />
      )}
    </button>
  )
}

function PlaybackModeButton({
  mode,
  size,
  onSwitch,
}: {
  mode: PlaybackMode
  size: number
  onSwitch: () => void
}) {
  const modeInfo = playbackModes.find((item) => item.value === mode)
  const Icon = modeInfo?.icon ?? ListEnd
  return (
    <button
      className="playback-mode-control active"
      onClick={onSwitch}
      aria-label={`播放模式：${modeInfo?.label ?? '顺序播放'}，点击切换`}
      title={modeInfo?.label ?? '顺序播放'}
    >
      <Icon size={size} />
    </button>
  )
}

function PlayerBar(props: PlayerBarProps) {
  return (
    <footer className="player-bar">
      <button
        ref={props.anchorRef}
        className="now-playing"
        onClick={props.onOpen}
        disabled={!props.track}
      >
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
          <button
            className={
              props.isFavorite ? 'favorite-control liked' : 'favorite-control'
            }
            onClick={props.onFavorite}
            disabled={!props.track}
            aria-label="添加到收藏"
            title="添加到收藏"
          >
            <Heart
              size={18}
              fill={props.isFavorite ? 'currentColor' : 'none'}
            />
          </button>
          <PlaybackDownloadButton
            state={props.downloadState ?? { status: 'idle', progress: null }}
            size={18}
            onDownload={props.onDownload}
            disabled={!props.track}
          />
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
          <PlaybackModeButton
            mode={props.playbackMode}
            size={18}
            onSwitch={props.onPlaybackMode}
          />
          <button
            onClick={props.onQueue}
            disabled={!props.track}
            aria-label="播放列表"
            title="播放列表"
          >
            <ListMusic size={19} />
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
  open: boolean
  origin: { x: number; y: number; scale: number }
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
  isFavorite: boolean
  downloadState: TrackDownloadState
  onDownload: () => void
  onFavorite: () => void
  onToggle: () => void
  onPrevious: () => void
  onNext: () => void
  playbackMode: PlaybackMode
  onPlaybackMode: () => void
  onQueue: () => void
  onSeek: (value: number) => void
  onOpenAlbum: () => void
  onClosed: () => void
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
      className={`player-page ${props.open ? 'is-open' : ''}`}
      aria-hidden={!props.open}
      onTransitionEnd={(event) => {
        if (
          event.target === event.currentTarget &&
          event.propertyName === 'transform' &&
          !props.open
        ) {
          props.onClosed()
        }
      }}
      style={
        {
          '--player-cover-size': `${coverSize}px`,
          '--player-origin-x': `${props.origin.x}px`,
          '--player-origin-y': `${props.origin.y}px`,
          '--player-origin-scale': props.origin.scale,
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
            <span>{props.track.singer}</span>
            {props.track.albumName && (
              <>
                {' · '}
                <button
                  className="player-album-link"
                  onClick={props.onOpenAlbum}
                  disabled={props.track.source === 'local'}
                >
                  {props.track.albumName}
                </button>
              </>
            )}
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
            <button
              className={
                props.isFavorite ? 'favorite-control liked' : 'favorite-control'
              }
              onClick={props.onFavorite}
              aria-label="添加到收藏"
              title="添加到收藏"
            >
              <Heart
                size={22}
                fill={props.isFavorite ? 'currentColor' : 'none'}
              />
            </button>
            <PlaybackDownloadButton
              state={props.downloadState}
              size={22}
              onDownload={props.onDownload}
            />
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
            <button
              onClick={props.onNext}
              aria-label="下一首"
              title="下一首"
            >
              <SkipForward size={24} fill="currentColor" />
            </button>
            <PlaybackModeButton
              mode={props.playbackMode}
              size={23}
              onSwitch={props.onPlaybackMode}
            />
            <button
              onClick={props.onQueue}
              aria-label="播放列表"
              title="播放列表"
            >
              <ListMusic size={23} />
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

