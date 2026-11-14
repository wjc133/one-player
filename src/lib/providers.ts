import { Buffer } from 'buffer'
import pako from 'pako'
import type {
  AlbumDetail,
  AlbumSearchResult,
  AlbumSummary,
  AppSettings,
  LyricPayload,
  MusicTrack,
  OnlineSourceKey,
  Quality,
  SearchResult,
  TrackQuality,
} from '../types'
import { decodeKuwoLyrics } from './kuwoLyrics'
import { requestHttp } from './tauri'

export const providerNames: Record<OnlineSourceKey, string> = {
  kw: '酷我',
  kg: '酷狗',
  tx: 'QQ',
  wy: '网易云',
  mg: '咪咕',
}

const limits: Record<OnlineSourceKey, number> = {
  kw: 30,
  kg: 30,
  tx: 30,
  wy: 30,
  mg: 20,
}

const albumLimits: Record<OnlineSourceKey, number> = {
  kw: 20,
  kg: 20,
  tx: 20,
  wy: 20,
  mg: 20,
}

const decodeHtml = (value: string | null | undefined) => {
  if (!value) return ''
  return new DOMParser().parseFromString(value, 'text/html').body.textContent ?? ''
}

const formatTime = (seconds: number | string | null | undefined) => {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value < 0) return null
  const minutes = Math.floor(value / 60)
  const rest = Math.floor(value % 60)
  return `${minutes.toString().padStart(2, '0')}:${rest
    .toString()
    .padStart(2, '0')}`
}

const formatSize = (bytes: number | string | null | undefined) => {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return null
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)} MB`
  return `${(value / 1024).toFixed(1)} KB`
}

const normalizeKuwoCover = (value: unknown) => {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) return raw.replace(/^http:/i, 'https:')
  const segments = raw.split('/')
  segments[0] = '500'
  return `https://img1.kuwo.cn/star/albumcover/${segments.join('/')}`
}

const pickKuwoCover = (...values: unknown[]) => {
  for (const value of values) {
    const cover = normalizeKuwoCover(value)
    if (cover) return cover
  }
  return null
}

const normalizeKugouCover = (value: unknown) => {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  return raw.replace('{size}', '400').replace(/^http:/i, 'https:')
}

const buildQualityMap = (types: TrackQuality[]) =>
  Object.fromEntries(
    types.map(({ type, size, hash }) => [type, { size, ...(hash ? { hash } : {}) }]),
  ) as MusicTrack['_types']

const requestText = async (
  url: string,
  settings: AppSettings,
  options: {
    method?: string
    headers?: Record<string, string>
    bodyText?: string
    form?: Record<string, string>
  } = {},
) => {
  const response = await requestHttp({
    url,
    proxy: settings.proxy || undefined,
    timeoutMs: 30_000,
    ...options,
  })
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`HTTP ${response.statusCode} ${response.statusMessage}`)
  }
  return response.bodyText
}

const requestJson = async <T>(
  url: string,
  settings: AppSettings,
  options?: {
    method?: string
    headers?: Record<string, string>
    bodyText?: string
    form?: Record<string, string>
  },
) => {
  const body = await requestText(url, settings, options)
  try {
    return JSON.parse(body) as T
  } catch {
    try {
      let normalized = ''
      let inSingleQuote = false
      for (let index = 0; index < body.length; index += 1) {
        const character = body[index]
        if (!inSingleQuote) {
          if (character === "'") {
            inSingleQuote = true
            normalized += '"'
          } else {
            normalized += character
          }
          continue
        }
        if (character === "'") {
          inSingleQuote = false
          normalized += '"'
          continue
        }
        if (character === '"') {
          normalized += '\\"'
          continue
        }
        if (character === '\n' || character === '\r') {
          normalized += '\\n'
          if (character === '\r' && body[index + 1] === '\n') index += 1
          continue
        }
        if (character !== '\\') {
          normalized += character
          continue
        }
        const next = body[index + 1]
        if (next === undefined) {
          normalized += '\\\\'
          continue
        }
        index += 1
        if (next === "'") {
          normalized += "'"
        } else if (next === '"') {
          normalized += '\\"'
        } else if (next === '\n' || next === '\r') {
          normalized += '\\n'
          if (next === '\r' && body[index + 1] === '\n') index += 1
        } else if ('\\/bfnrtu'.includes(next)) {
          normalized += `\\${next}`
        } else {
          normalized += next
        }
      }
      return JSON.parse(normalized) as T
    } catch {}
    const jsonp = /^[^(]*\(([\s\S]*)\)\s*;?\s*$/.exec(body)
    if (jsonp) return JSON.parse(jsonp[1]) as T
    throw new Error('音乐平台返回了无法解析的数据')
  }
}

const createTrack = (
  source: OnlineSourceKey,
  value: Omit<MusicTrack, 'id' | 'source' | 'typeUrl'>,
): MusicTrack => ({
  ...value,
  id:
    source === 'kg'
      ? `${String(value.songmid)}_${value.hash ?? ''}`
      : `${source}_${String(value.songmid)}`,
  source,
  typeUrl: {},
})

const createAlbum = (
  source: OnlineSourceKey,
  value: Omit<AlbumSummary, 'source'>,
): AlbumSummary => ({
  ...value,
  source,
})

const albumsFromTracks = (
  source: OnlineSourceKey,
  tracks: MusicTrack[],
): AlbumSummary[] => {
  const albums = new Map<string, AlbumSummary>()
  for (const track of tracks) {
    const id = String(track.albumMid ?? track.albumId ?? '')
    if (!id || !track.albumName) continue
    const key = `${source}_${id}`
    if (albums.has(key)) continue
    albums.set(
      key,
      createAlbum(source, {
        id,
        albumMid: track.albumMid,
        name: track.albumName,
        singer: track.singer,
        img: track.img ?? null,
      }),
    )
  }
  return [...albums.values()]
}

const tencentSignPart1Indexes = [23, 14, 6, 36, 16, 40, 7, 19]
const tencentSignPart2Indexes = [16, 1, 32, 12, 19, 27, 8, 5]
const tencentSignScrambleValues = [
  89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133,
  143, 161, 121, 179,
]

const createTencentSearchId = () => {
  let guid = ''
  for (let index = 0; index < 32; index += 1) {
    guid += Math.floor(Math.random() * 16).toString(16)
  }
  return `${guid.toUpperCase()}${String(
    Math.floor(Math.random() * 100_000),
  ).padStart(5, '0')}`
}

const signTencentRequest = async (body: string) => {
  const forge = (await import('node-forge')).default
  const hash = forge.md.sha1.create().update(body, 'utf8').digest().toHex()
  const pickHash = (indexes: number[]) =>
    indexes.map((index) => hash[index]).join('')
  const scrambled = Buffer.from(
    tencentSignScrambleValues.map(
      (value, index) =>
        value ^ Number.parseInt(hash.slice(index * 2, index * 2 + 2), 16),
    ),
  )
    .toString('base64')
    .replace(/[\\/+=]/g, '')
  return `zzc${pickHash(tencentSignPart1Indexes)}${scrambled}${pickHash(
    tencentSignPart2Indexes,
  )}`.toLowerCase()
}

const requestTencentSearch = async (
  keyword: string,
  page: number,
  limit: number,
  searchType: 0 | 2,
  settings: AppSettings,
) => {
  const payload = {
    comm: {
      _channelid: '0',
      _os_version: '6.2.9200-2',
      ct: '19',
      cv: '2151',
      guid: '1F70E520B2EAA7D25E11760783C53CA9',
      patch: '118',
      psrf_access_token_expiresAt: 0,
      psrf_qqaccess_token: '',
      psrf_qqopenid: '',
      psrf_qqunionid: '',
      tmeAppID: 'qqmusic',
      tmeLoginType: 0,
      uin: '0',
      wid: '7223299733393904640',
    },
    'music.search.SearchCgiService': {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: {
        grp: 1,
        num_per_page: limit,
        page_num: page,
        query: keyword,
        remoteplace: 'txt.newclient.top',
        search_type: searchType,
        searchid: createTencentSearchId(),
      },
    },
  }
  const bodyText = JSON.stringify(payload)
  const sign = await signTencentRequest(bodyText)
  const data = await requestJson<{
    code?: number
    'music.search.SearchCgiService'?: {
      code?: number
      data?: {
        body?: {
          album?: { list?: Array<Record<string, unknown>> }
          song?: { list?: Array<Record<string, unknown>> }
        }
        meta?: { sum?: number }
      }
    }
  }>(
    `https://u.y.qq.com/cgi-bin/musics.fcg?sign=${encodeURIComponent(sign)}`,
    settings,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'QQMusic 14090508(android 12)',
      },
      bodyText,
    },
  )
  const response = data['music.search.SearchCgiService']
  if (data.code !== 0 || response?.code !== 0 || !response.data) {
    throw new Error('QQ 音乐搜索失败')
  }
  return response.data
}

const searchKuwo = async (
  keyword: string,
  page: number,
  settings: AppSettings,
): Promise<SearchResult> => {
  const limit = limits.kw
  const url = `http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(
    keyword,
  )}&pn=${page - 1}&rn=${limit}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1`
  const data = await requestJson<{
    TOTAL?: string
    abslist?: Array<Record<string, string>>
  }>(url, settings)
  const list = (data.abslist ?? []).flatMap((item) => {
    if (!item.N_MINFO) return []
    const types: TrackQuality[] = []
    for (const raw of item.N_MINFO.split(';')) {
      const match = /level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)/.exec(raw)
      if (!match) continue
      const quality: Record<string, Quality> = {
        '128': '128k',
        '320': '320k',
        '2000': 'flac',
        '4000': 'flac24bit',
      }
      const type = quality[match[2]]
      if (type) types.push({ type, size: match[4].toUpperCase() })
    }
    types.reverse()
    const songmid = (item.MUSICRID ?? '').replace('MUSIC_', '')
    if (!songmid) return []
    return [
      createTrack('kw', {
        name: decodeHtml(item.SONGNAME),
        singer: decodeHtml(item.ARTIST).replaceAll('&', '、'),
        songmid,
        interval: formatTime(item.DURATION),
        albumName: decodeHtml(item.ALBUM),
        albumId: decodeHtml(item.ALBUMID),
        img: normalizeKuwoCover(item.web_albumpic_short),
        types,
        _types: buildQualityMap(types),
      }),
    ]
  })
  const total = Number.parseInt(data.TOTAL ?? '0', 10) || 0
  return {
    list,
    allPage: Math.max(1, Math.ceil(total / limit)),
    total,
    limit,
    source: 'kw',
  }
}

const searchKugou = async (
  keyword: string,
  page: number,
  settings: AppSettings,
): Promise<SearchResult> => {
  const limit = limits.kg
  const url = `http://songsearch.kugou.com/song_search_v2?platform=AndroidFilter&iscorrection=1&keyword=${encodeURIComponent(
    keyword,
  )}&hifiquality=0&pagesize=${limit}&PrivilegeFilter=0&page=${page}`
  const data = await requestJson<{
    error_code: number
    data?: { total?: number; lists?: Array<Record<string, unknown>> }
  }>(url, settings)
  if (data.error_code !== 0) throw new Error('酷狗搜索失败')
  const seen = new Set<string>()
  const rawList: Array<Record<string, unknown>> = []
  for (const item of data.data?.lists ?? []) {
    rawList.push(item)
    if (Array.isArray(item.Grp)) {
      rawList.push(...(item.Grp as Array<Record<string, unknown>>))
    }
  }
  const list = rawList.flatMap((item) => {
    const hash = String(item.FileHash ?? '')
    const songmid = String(item.Audioid ?? '')
    const key = `${songmid}_${hash}`
    if (!hash || !songmid || seen.has(key)) return []
    seen.add(key)
    const types: TrackQuality[] = []
    const candidates: Array<[Quality, unknown, unknown]> = [
      ['128k', item.FileSize, item.FileHash],
      ['320k', item.HQFileSize, item.HQFileHash],
      ['flac', item.SQFileSize, item.SQFileHash],
      ['flac24bit', item.ResFileSize, item.ResFileHash],
    ]
    for (const [type, size, qualityHash] of candidates) {
      if (Number(size) > 0) {
        types.push({
          type,
          size: formatSize(Number(size)),
          hash: String(qualityHash ?? hash),
        })
      }
    }
    const singers = Array.isArray(item.Singers)
      ? item.Singers
          .map((singer) =>
            typeof singer === 'object' && singer
              ? String((singer as Record<string, unknown>).name ?? '')
              : '',
          )
          .filter(Boolean)
          .join('、')
      : String(item.SingerName ?? '')
    const suffix = String(item.Suffix ?? '')
    return [
      createTrack('kg', {
        name: decodeHtml(`${String(item.OriSongName ?? '')}${suffix ? ` ${suffix}` : ''}`),
        singer: decodeHtml(singers),
        songmid,
        interval: formatTime(Number(item.Duration)),
        albumName: decodeHtml(String(item.AlbumName ?? '')),
        albumId: String(item.AlbumID ?? ''),
        albumAudioId: String(item.MixSongID ?? ''),
        _interval: Number(item.Duration) || 0,
        hash,
        img: normalizeKugouCover(
          item.Image ||
            (item.trans_param as Record<string, unknown> | undefined)
              ?.union_cover,
        ),
        types,
        _types: buildQualityMap(types),
      }),
    ]
  })
  const total = Number(data.data?.total ?? 0)
  return {
    list,
    allPage: Math.max(1, Math.ceil(total / limit)),
    total,
    limit,
    source: 'kg',
  }
}

const searchTencent = async (
  keyword: string,
  page: number,
  settings: AppSettings,
): Promise<SearchResult> => {
  const limit = limits.tx
  const data = await requestTencentSearch(keyword, page, limit, 0, settings)
  const list = (data.body?.song?.list ?? []).flatMap((item) => {
    const file = item.file as Record<string, unknown> | undefined
    const mediaMid = String(file?.media_mid ?? '')
    const songmid = String(item.mid ?? item.songmid ?? '')
    if (!mediaMid || !songmid) return []
    const types: TrackQuality[] = []
    const candidates: Array<[Quality, unknown]> = [
      ['128k', file?.size_128mp3],
      ['320k', file?.size_320mp3],
      ['flac', file?.size_flac],
      ['flac24bit', file?.size_hires],
    ]
    for (const [type, size] of candidates) {
      if (Number(size) > 0) types.push({ type, size: formatSize(Number(size)) })
    }
    const singers = Array.isArray(item.singer)
      ? item.singer
          .map((singer) =>
            typeof singer === 'object' && singer
              ? String((singer as Record<string, unknown>).name ?? '')
              : '',
          )
          .filter(Boolean)
          .join('、')
      : ''
    const album = item.album as Record<string, unknown> | undefined
    const albumId = String(album?.mid ?? '')
    return [
      createTrack('tx', {
        name: decodeHtml(String(item.title ?? item.name ?? '')),
        singer: decodeHtml(singers),
        songmid,
        interval: formatTime(Number(item.interval)),
        albumName: decodeHtml(String(album?.name ?? '')),
        albumId,
        albumMid: albumId,
        songId: Number(item.id) || undefined,
        strMediaMid: mediaMid,
        img: albumId
          ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumId}.jpg`
          : null,
        types,
        _types: buildQualityMap(types),
      }),
    ]
  })
  const total = Number(data.meta?.sum ?? 0)
  return {
    list,
    allPage: Math.max(1, Math.ceil(total / limit)),
    total,
    limit,
    source: 'tx',
  }
}

const searchNetease = async (
  keyword: string,
  page: number,
  settings: AppSettings,
): Promise<SearchResult> => {
  const limit = limits.wy
  const offset = (page - 1) * limit
  const data = await requestJson<{
    code?: number
    result?: {
      songCount?: number
      songs?: Array<Record<string, unknown>>
    }
  }>(
    `https://music.163.com/api/search/get/web?csrf_token=&s=${encodeURIComponent(
      keyword,
    )}&type=1&offset=${offset}&total=true&limit=${limit}`,
    settings,
    {
      headers: {
        Referer: 'https://music.163.com/',
        'User-Agent': 'Mozilla/5.0',
      },
    },
  )
  if (data.code && data.code !== 200) throw new Error('网易云搜索失败')
  const list = (data.result?.songs ?? []).flatMap((item) => {
    const songmid = String(item.id ?? '')
    if (!songmid) return []
    const artists = (item.artists ?? item.ar) as
      | Array<Record<string, unknown>>
      | undefined
    const album = (item.album ?? item.al) as Record<string, unknown> | undefined
    const types: TrackQuality[] = [
      { type: '128k', size: null },
      { type: '320k', size: null },
      { type: 'flac', size: null },
    ]
    return [
      createTrack('wy', {
        name: decodeHtml(String(item.name ?? '')),
        singer: (artists ?? [])
          .map((artist) => String(artist.name ?? ''))
          .filter(Boolean)
          .join('、'),
        songmid,
        interval: formatTime(Number(item.duration ?? item.dt) / 1_000),
        albumName: decodeHtml(String(album?.name ?? '')),
        albumId: String(album?.id ?? ''),
        img: String(album?.picUrl ?? '') || null,
        types,
        _types: buildQualityMap(types),
      }),
    ]
  })
  const total = Number(data.result?.songCount ?? 0)
  return {
    list,
    allPage: Math.max(1, Math.ceil(total / limit)),
    total,
    limit,
    source: 'wy',
  }
}

const createMiguHeaders = async (keyword: string) => {
  const timestamp = Date.now().toString()
  const deviceId = '963B7AA0D21511ED807EE5846EC87D20'
  const forge = (await import('node-forge')).default
  const signature = forge.md.md5
    .create()
    .update(
      `${keyword}6cdc72a439cef99a3418d2a78aa28c73yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${timestamp}`,
      'utf8',
    )
    .digest()
    .toHex()
  return {
    uiVersion: 'A_music_3.6.1',
    deviceId,
    timestamp,
    sign: signature,
    channel: '0146921',
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 11; Mobile) AppleWebKit/537.36',
  }
}

const searchMigu = async (
  keyword: string,
  page: number,
  settings: AppSettings,
): Promise<SearchResult> => {
  const limit = limits.mg
  const url = `https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A1%2C%22mvSong%22%3A0%2C%22bestShow%22%3A1%2C%22songlist%22%3A0%2C%22lyricSong%22%3A0%7D&pageSize=${limit}&text=${encodeURIComponent(
    keyword,
  )}&pageNo=${page}&sort=0&sid=USS`
  const data = await requestJson<{
    code?: string
    info?: string
    songResultData?: {
      totalCount?: string | number
      resultList?: Array<Array<Record<string, unknown>>>
    }
  }>(url, settings, {
    headers: await createMiguHeaders(keyword),
  })
  if (data.code !== '000000') throw new Error(data.info || '咪咕搜索失败')
  const seen = new Set<string>()
  const list = (data.songResultData?.resultList ?? []).flatMap((group) =>
    group.flatMap((item) => {
      const songmid = String(item.songId ?? '')
      const copyrightId = String(item.copyrightId ?? '')
      if (!songmid || !copyrightId || seen.has(copyrightId)) return []
      seen.add(copyrightId)
      const types: TrackQuality[] = []
      if (Array.isArray(item.audioFormats)) {
        const map: Record<string, Quality> = {
          PQ: '128k',
          HQ: '320k',
          SQ: 'flac',
          ZQ24: 'flac24bit',
        }
        for (const format of item.audioFormats as Array<Record<string, unknown>>) {
          const type = map[String(format.formatType ?? '')]
          if (type) {
            types.push({
              type,
              size: formatSize(Number(format.asize ?? format.isize)),
            })
          }
        }
      }
      const singerList = item.singerList as
        | Array<Record<string, unknown>>
        | undefined
      let img = String(item.img3 ?? item.img2 ?? item.img1 ?? '')
      if (img && !/^https?:/i.test(img)) img = `http://d.musicapp.migu.cn${img}`
      return [
        createTrack('mg', {
          name: decodeHtml(String(item.name ?? '')),
          singer: (singerList ?? [])
            .map((singer) => String(singer.name ?? ''))
            .filter(Boolean)
            .join('、'),
          songmid,
          interval: formatTime(Number(item.duration)),
          albumName: decodeHtml(String(item.album ?? '')),
          albumId: String(item.albumId ?? ''),
          copyrightId,
          img: img || null,
          lrcUrl: String(item.lrcUrl ?? '') || undefined,
          mrcUrl: String(item.mrcurl ?? '') || undefined,
          trcUrl: String(item.trcUrl ?? '') || undefined,
          types,
          _types: buildQualityMap(types),
        }),
      ]
    }),
  )
  const total = Number(data.songResultData?.totalCount ?? 0)
  return {
    list,
    allPage: Math.max(1, Math.ceil(total / limit)),
    total,
    limit,
    source: 'mg',
  }
}

const parseKuwoTypes = (item: Record<string, unknown>) => {
  const types: TrackQuality[] = []
  const qualityMap: Record<string, Quality> = {
    '128': '128k',
    '320': '320k',
    '2000': 'flac',
    '4000': 'flac24bit',
  }
  for (const raw of String(item.N_MINFO ?? item.MINFO ?? '').split(';')) {
    const match = /level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)/.exec(raw)
    const type = match ? qualityMap[match[2]] : undefined
    if (type) types.push({ type, size: match?.[4]?.toUpperCase() ?? null })
  }
  if (!types.length) {
    const formats = String(item.formats ?? item.FORMATS ?? '').split('|')
    const candidates: Array<[string, Quality]> = [
      ['MP3128', '128k'],
      ['MP3H', '320k'],
      ['ALFLAC', 'flac'],
      ['HIRFLAC', 'flac24bit'],
    ]
    for (const [format, type] of candidates) {
      if (formats.includes(format)) types.push({ type, size: null })
    }
  }
  return types.reverse()
}

const searchKuwoAlbums = async (
  keyword: string,
  page: number,
  settings: AppSettings,
): Promise<AlbumSearchResult> => {
  const limit = albumLimits.kw
  const data = await requestJson<{
    TOTAL?: string
    SHOW?: string
    albumlist?: Array<Record<string, unknown>>
  }>(
    `http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(
      keyword,
    )}&pn=${page - 1}&rn=${limit}&ft=album&encoding=utf8&rformat=json`,
    settings,
  )
  const list = (data.albumlist ?? []).flatMap((item) => {
    const id = String(item.albumid ?? item.id ?? '')
    if (!id) return []
    return [
      createAlbum('kw', {
        id,
        name: decodeHtml(String(item.album ?? item.name ?? '')),
        singer: decodeHtml(String(item.artist ?? item.aartist ?? '')),
        img: normalizeKuwoCover(item.hts_img ?? item.img ?? item.pic),
        publishTime: String(item.pub ?? item.releaseDate ?? '') || undefined,
        songCount: Number(item.songnum) || undefined,
      }),
    ]
  })
  const total = Number(data.TOTAL ?? data.SHOW ?? list.length)
  return {
    list,
    allPage: Math.max(1, Math.ceil(total / limit)),
    total,
    limit,
    source: 'kw',
  }
}

const searchKugouAlbums = async (
  keyword: string,
  page: number,
  settings: AppSettings,
): Promise<AlbumSearchResult> => {
  const limit = albumLimits.kg
  const data = await requestJson<{
    status?: number
    data?: {
      total?: number
      info?: Array<Record<string, unknown>>
    }
  }>(
    `http://mobilecdn.kugou.com/api/v3/search/album?format=json&keyword=${encodeURIComponent(
      keyword,
    )}&page=${page}&pagesize=${limit}`,
    settings,
  )
  const list = (data.data?.info ?? []).flatMap((item) => {
    const id = String(item.albumid ?? '')
    if (!id) return []
    return [
      createAlbum('kg', {
        id,
        name: decodeHtml(String(item.albumname ?? '')),
        singer: decodeHtml(String(item.singername ?? '')),
        img: normalizeKugouCover(item.imgurl),
        publishTime: String(item.publishtime ?? '') || undefined,
        songCount: Number(item.songcount) || undefined,
      }),
    ]
  })
  const total = Number(data.data?.total ?? list.length)
  return {
    list,
    allPage: Math.max(1, Math.ceil(total / limit)),
    total,
    limit,
    source: 'kg',
  }
}

const searchTencentAlbums = async (
  keyword: string,
  page: number,
  settings: AppSettings,
): Promise<AlbumSearchResult> => {
  const limit = albumLimits.tx
  try {
    const data = await requestTencentSearch(keyword, page, limit, 2, settings)
    const list = (data.body?.album?.list ?? []).flatMap((item) => {
      const albumMid = String(item.albumMID ?? item.albumMid ?? '')
      const id = albumMid || String(item.albumID ?? item.albumId ?? '')
      if (!id) return []
      return [
        createAlbum('tx', {
          id,
          albumMid: albumMid || undefined,
          name: decodeHtml(
            String(item.albumName ?? item.album_name ?? item.name ?? ''),
          ),
          singer: decodeHtml(
            String(item.singerName ?? item.singer_name ?? item.singer ?? ''),
          ),
          img: albumMid
            ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg`
            : null,
          publishTime:
            String(item.publicTime ?? item.publish_date ?? '') || undefined,
          songCount: Number(item.song_count ?? item.songCount) || undefined,
        }),
      ]
    })
    if (list.length) {
      const total = Number(data.meta?.sum ?? list.length)
      return {
        list,
        allPage: Math.max(1, Math.ceil(total / limit)),
        total,
        limit,
        source: 'tx',
      }
    }
  } catch {}
  const musicResult = await searchTencent(keyword, page, settings)
  const list = albumsFromTracks('tx', musicResult.list)
  return {
    list,
    allPage: musicResult.allPage,
    total: list.length,
    limit,
    source: 'tx',
  }
}

const searchNeteaseAlbums = async (
  keyword: string,
  page: number,
  settings: AppSettings,
): Promise<AlbumSearchResult> => {
  const limit = albumLimits.wy
  const offset = (page - 1) * limit
  const data = await requestJson<{
    code?: number
    result?: {
      albumCount?: number
      albums?: Array<Record<string, unknown>>
    }
  }>(
    `https://music.163.com/api/search/get/web?csrf_token=&s=${encodeURIComponent(
      keyword,
    )}&type=10&offset=${offset}&total=true&limit=${limit}`,
    settings,
    {
      headers: {
        Referer: 'https://music.163.com/',
        'User-Agent': 'Mozilla/5.0',
      },
    },
  )
  if (data.code && data.code !== 200) throw new Error('网易云专辑搜索失败')
  const list = (data.result?.albums ?? []).flatMap((item) => {
    const id = String(item.id ?? '')
    if (!id) return []
    const artist = item.artist as Record<string, unknown> | undefined
    return [
      createAlbum('wy', {
        id,
        name: decodeHtml(String(item.name ?? '')),
        singer: decodeHtml(String(artist?.name ?? '')),
        img: String(item.picUrl ?? item.blurPicUrl ?? '') || null,
        publishTime: Number(item.publishTime)
          ? new Date(Number(item.publishTime)).toLocaleDateString()
          : undefined,
        songCount: Number(item.size) || undefined,
      }),
    ]
  })
  const total = Number(data.result?.albumCount ?? list.length)
  return {
    list,
    allPage: Math.max(1, Math.ceil(total / limit)),
    total,
    limit,
    source: 'wy',
  }
}

const searchMiguAlbums = async (
  keyword: string,
  page: number,
  settings: AppSettings,
): Promise<AlbumSearchResult> => {
  const limit = albumLimits.mg
  const url = `https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1&searchSwitch=%7B%22song%22%3A0%2C%22album%22%3A1%2C%22singer%22%3A0%2C%22tagSong%22%3A0%2C%22mvSong%22%3A0%2C%22bestShow%22%3A0%2C%22songlist%22%3A0%2C%22lyricSong%22%3A0%7D&pageSize=${limit}&text=${encodeURIComponent(
    keyword,
  )}&pageNo=${page}&sort=0&sid=USS`
  const data = await requestJson<{
    code?: string
    info?: string
    albumResultData?: {
      totalCount?: string | number
      result?: Array<Record<string, unknown>>
    }
  }>(url, settings, {
    headers: await createMiguHeaders(keyword),
  })
  if (data.code !== '000000') throw new Error(data.info || '咪咕专辑搜索失败')
  const list = (data.albumResultData?.result ?? []).flatMap((item) => {
    const id = String(item.id ?? '')
    if (!id) return []
    const images = item.imgItems as Array<Record<string, unknown>> | undefined
    return [
      createAlbum('mg', {
        id,
        name: decodeHtml(String(item.name ?? '')),
        singer: decodeHtml(String(item.singer ?? '')).replaceAll('|', '、'),
        img: String(images?.[0]?.img ?? '') || null,
        publishTime: String(item.publishDate ?? item.desc ?? '') || undefined,
      }),
    ]
  })
  const total = Number(data.albumResultData?.totalCount ?? list.length)
  return {
    list,
    allPage: Math.max(1, Math.ceil(total / limit)),
    total,
    limit,
    source: 'mg',
  }
}

const getKuwoAlbumDetail = async (
  album: AlbumSummary,
  settings: AppSettings,
): Promise<AlbumDetail> => {
  const data = await requestJson<Record<string, unknown>>(
    `http://search.kuwo.cn/r.s?pn=0&rn=1000&stype=albuminfo&albumid=${encodeURIComponent(
      album.id,
    )}&show_copyright_off=0&encoding=utf&vipver=MUSIC_9.1.0`,
    settings,
  )
  const albumName = decodeHtml(String(data.name ?? album.name))
  const albumId = String(data.albumid ?? album.id)
  const albumCover = pickKuwoCover(
    album.img,
    data.hts_img,
    data.img,
    data.pic,
  )
  const list = (
    (data.musiclist as Array<Record<string, unknown>> | undefined) ?? []
  ).flatMap((item) => {
    const songmid = String(item.id ?? item.MUSICRID ?? '').replace('MUSIC_', '')
    if (!songmid) return []
    const types = parseKuwoTypes(item)
    return [
      createTrack('kw', {
        name: decodeHtml(String(item.name ?? item.SONGNAME ?? '')),
        singer: decodeHtml(String(item.artist ?? item.ARTIST ?? album.singer))
          .replaceAll('&', '、'),
        songmid,
        interval: formatTime(Number(item.duration ?? item.DURATION)),
        albumName,
        albumId,
        img: pickKuwoCover(
          item.web_albumpic_short,
          item.pic,
          albumCover,
        ),
        types,
        _types: buildQualityMap(types),
      }),
    ]
  })
  return {
    album: {
      ...album,
      id: albumId,
      name: albumName,
      singer: decodeHtml(String(data.artist ?? album.singer)),
      img: albumCover,
      songCount: list.length,
    },
    list,
  }
}

const getKugouAlbumDetail = async (
  album: AlbumSummary,
  settings: AppSettings,
): Promise<AlbumDetail> => {
  const data = await requestJson<{
    data?: {
      total?: number
      info?: Array<Record<string, unknown>>
    }
  }>(
    `http://mobiles.kugou.com/api/v3/album/song?version=9108&albumid=${encodeURIComponent(
      album.id,
    )}&plat=0&pagesize=200&area_code=0&page=1&with_res_tag=0`,
    settings,
  )
  const list = (data.data?.info ?? []).flatMap((item) => {
    const hash = String(item.hash ?? '')
    const songmid = String(item.audio_id ?? '')
    if (!hash || !songmid) return []
    const types: TrackQuality[] = []
    const candidates: Array<[Quality, unknown, unknown]> = [
      ['128k', item.filesize, item.hash],
      ['320k', item['320filesize'], item['320hash']],
      ['flac', item.sqfilesize, item.sqhash],
      ['flac24bit', item.filesize_high, item.hash_high],
    ]
    for (const [type, size, qualityHash] of candidates) {
      if (Number(size) > 0) {
        types.push({
          type,
          size: formatSize(Number(size)),
          hash: String(qualityHash ?? hash),
        })
      }
    }
    const filename = decodeHtml(String(item.filename ?? ''))
    const separator = filename.indexOf(' - ')
    const singer = separator >= 0 ? filename.slice(0, separator) : album.singer
    const name = separator >= 0 ? filename.slice(separator + 3) : filename
    const transParam = item.trans_param as Record<string, unknown> | undefined
    return [
      createTrack('kg', {
        name,
        singer,
        songmid,
        interval: formatTime(Number(item.duration)),
        albumName: album.name,
        albumId: album.id,
        albumAudioId: String(item.album_audio_id ?? ''),
        _interval: Number(item.duration) || 0,
        hash,
        img:
          String(transParam?.union_cover ?? album.img ?? '')
            .replace('{size}', '400')
            .replace(/^http:/, 'https:') || null,
        types,
        _types: buildQualityMap(types),
      }),
    ]
  })
  return {
    album: { ...album, songCount: Number(data.data?.total ?? list.length) },
    list,
  }
}

const getTencentAlbumDetail = async (
  album: AlbumSummary,
  settings: AppSettings,
): Promise<AlbumDetail> => {
  const albumMid = album.albumMid ?? album.id
  const data = await requestJson<{
    code?: number
    data?: Record<string, unknown> & {
      list?: Array<Record<string, unknown>>
    }
  }>(
    `https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg?albummid=${encodeURIComponent(
      albumMid,
    )}&format=json&platform=yqq`,
    settings,
    {
      headers: {
        Referer: 'https://y.qq.com/',
        'User-Agent': 'Mozilla/5.0',
      },
    },
  )
  if (data.code && data.code !== 0) throw new Error('QQ 音乐专辑加载失败')
  const list = (data.data?.list ?? []).flatMap((item) => {
    const songmid = String(item.songmid ?? '')
    const mediaMid = String(item.strMediaMid ?? '')
    if (!songmid || !mediaMid) return []
    const types: TrackQuality[] = []
    const candidates: Array<[Quality, unknown]> = [
      ['128k', item.size128],
      ['320k', item.size320],
      ['flac', item.sizeflac],
      ['flac24bit', item.size_hires],
    ]
    for (const [type, size] of candidates) {
      if (Number(size) > 0) types.push({ type, size: formatSize(Number(size)) })
    }
    const singers = Array.isArray(item.singer)
      ? (item.singer as Array<Record<string, unknown>>)
          .map((singer) => String(singer.name ?? ''))
          .filter(Boolean)
          .join('、')
      : album.singer
    return [
      createTrack('tx', {
        name: decodeHtml(String(item.songname ?? item.songorig ?? '')),
        singer: decodeHtml(singers),
        songmid,
        interval: formatTime(Number(item.interval)),
        albumName: decodeHtml(String(item.albumname ?? album.name)),
        albumId: String(item.albummid ?? albumMid),
        albumMid: String(item.albummid ?? albumMid),
        songId: Number(item.songid) || undefined,
        strMediaMid: mediaMid,
        img:
          `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg`,
        types,
        _types: buildQualityMap(types),
      }),
    ]
  })
  return {
    album: {
      ...album,
      id: albumMid,
      albumMid,
      name: decodeHtml(String(data.data?.name ?? album.name)),
      singer: decodeHtml(String(data.data?.singername ?? album.singer)),
      img: `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg`,
      songCount: Number(data.data?.cur_song_num ?? list.length),
    },
    list,
  }
}

const getNeteaseAlbumDetail = async (
  album: AlbumSummary,
  settings: AppSettings,
): Promise<AlbumDetail> => {
  const data = await requestJson<{
    code?: number
    album?: Record<string, unknown>
    songs?: Array<Record<string, unknown>>
  }>(
    `https://music.163.com/api/v1/album/${encodeURIComponent(album.id)}`,
    settings,
    {
      headers: {
        Referer: 'https://music.163.com/',
        'User-Agent': 'Mozilla/5.0',
      },
    },
  )
  if (data.code && data.code !== 200) throw new Error('网易云专辑加载失败')
  const list = (data.songs ?? []).flatMap((item) => {
    const songmid = String(item.id ?? '')
    if (!songmid) return []
    const artists = (item.ar ?? item.artists) as
      | Array<Record<string, unknown>>
      | undefined
    const itemAlbum = (item.al ?? item.album) as
      | Record<string, unknown>
      | undefined
    const types: TrackQuality[] = [
      { type: '128k', size: null },
      { type: '320k', size: null },
      { type: 'flac', size: null },
    ]
    return [
      createTrack('wy', {
        name: decodeHtml(String(item.name ?? '')),
        singer: (artists ?? [])
          .map((artist) => String(artist.name ?? ''))
          .filter(Boolean)
          .join('、'),
        songmid,
        interval: formatTime(Number(item.dt ?? item.duration) / 1_000),
        albumName: decodeHtml(String(itemAlbum?.name ?? album.name)),
        albumId: String(itemAlbum?.id ?? album.id),
        img: String(itemAlbum?.picUrl ?? album.img ?? '') || null,
        types,
        _types: buildQualityMap(types),
      }),
    ]
  })
  const artist = data.album?.artist as Record<string, unknown> | undefined
  return {
    album: {
      ...album,
      name: decodeHtml(String(data.album?.name ?? album.name)),
      singer: decodeHtml(String(artist?.name ?? album.singer)),
      img: String(data.album?.picUrl ?? album.img ?? '') || null,
      songCount: Number(data.album?.size ?? list.length),
    },
    list,
  }
}

const getMiguAlbumDetail = async (
  album: AlbumSummary,
  settings: AppSettings,
): Promise<AlbumDetail> => {
  const data = await requestJson<{
    code?: string
    info?: string
    data?: {
      songList?: Array<Record<string, unknown>>
    }
  }>(
    `http://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/queryAlbumSong?albumId=${encodeURIComponent(
      album.id,
    )}&pageNo=1`,
    settings,
  )
  if (data.code !== '000000') throw new Error(data.info || '咪咕专辑加载失败')
  const list = (data.data?.songList ?? []).flatMap((item) => {
    const songmid = String(item.songId ?? '')
    const copyrightId = String(item.copyrightId ?? '')
    if (!songmid || !copyrightId) return []
    const formats = (item.newRateFormats ?? item.rateFormats) as
      | Array<Record<string, unknown>>
      | undefined
    const qualityMap: Record<string, Quality> = {
      PQ: '128k',
      HQ: '320k',
      SQ: 'flac',
      ZQ: 'flac24bit',
      ZQ24: 'flac24bit',
    }
    const types: TrackQuality[] = []
    for (const format of formats ?? []) {
      const type = qualityMap[String(format.formatType ?? '')]
      if (type && !types.some((quality) => quality.type === type)) {
        types.push({ type, size: formatSize(Number(format.size)) })
      }
    }
    const images = item.albumImgs as Array<Record<string, unknown>> | undefined
    return [
      createTrack('mg', {
        name: decodeHtml(String(item.songName ?? '')),
        singer: decodeHtml(String(item.singer ?? '')).replaceAll('|', '、'),
        songmid,
        interval:
          String(item.length ?? '') || formatTime(Number(item.duration)),
        albumName: decodeHtml(String(item.album ?? album.name)),
        albumId: String(item.albumId ?? album.id),
        copyrightId,
        img: String(images?.[0]?.img ?? album.img ?? '') || null,
        lrcUrl: String(item.lrcUrl ?? '') || undefined,
        mrcUrl: String(item.mrcUrl ?? '') || undefined,
        trcUrl: String(item.trcUrl ?? '') || undefined,
        types,
        _types: buildQualityMap(types),
      }),
    ]
  })
  return {
    album: { ...album, songCount: list.length },
    list,
  }
}

export const searchAlbums = (
  source: OnlineSourceKey,
  keyword: string,
  page: number,
  settings: AppSettings,
) => {
  switch (source) {
    case 'kw':
      return searchKuwoAlbums(keyword, page, settings)
    case 'kg':
      return searchKugouAlbums(keyword, page, settings)
    case 'tx':
      return searchTencentAlbums(keyword, page, settings)
    case 'wy':
      return searchNeteaseAlbums(keyword, page, settings)
    case 'mg':
      return searchMiguAlbums(keyword, page, settings)
  }
}

export const getAlbumDetail = (
  album: AlbumSummary,
  settings: AppSettings,
) => {
  switch (album.source) {
    case 'kw':
      return getKuwoAlbumDetail(album, settings)
    case 'kg':
      return getKugouAlbumDetail(album, settings)
    case 'tx':
      return getTencentAlbumDetail(album, settings)
    case 'wy':
      return getNeteaseAlbumDetail(album, settings)
    case 'mg':
      return getMiguAlbumDetail(album, settings)
  }
}

export const searchMusic = (
  source: OnlineSourceKey,
  keyword: string,
  page: number,
  settings: AppSettings,
) => {
  switch (source) {
    case 'kw':
      return searchKuwo(keyword, page, settings)
    case 'kg':
      return searchKugou(keyword, page, settings)
    case 'tx':
      return searchTencent(keyword, page, settings)
    case 'wy':
      return searchNetease(keyword, page, settings)
    case 'mg':
      return searchMigu(keyword, page, settings)
  }
}

const formatLrcTime = (seconds: number) => {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes.toString().padStart(2, '0')}:${rest.toFixed(3).padStart(6, '0')}`
}

const getKuwoLyrics = async (
  track: MusicTrack,
  settings: AppSettings,
): Promise<LyricPayload> => {
  const response = await requestHttp({
    url: `http://mlyric.kuwo.cn/mobi.s?f=web&type=lyric&lrcx=1&rid=${encodeURIComponent(
      String(track.songmid),
    )}&encode=utf8`,
    proxy: settings.proxy || undefined,
    timeoutMs: 30_000,
  })
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`HTTP ${response.statusCode} ${response.statusMessage}`)
  }
  const lyrics = decodeKuwoLyrics(response.rawBase64)
  return {
    lyric: decodeHtml(lyrics.lyric),
    tlyric: decodeHtml(lyrics.tlyric),
  }
}

const decodeKrc = (content: string): LyricPayload => {
  const key = Buffer.from([
    0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d,
    0xce, 0xd2, 0x6e, 0x69,
  ])
  const encrypted = Buffer.from(content, 'base64').subarray(4)
  for (let index = 0; index < encrypted.length; index += 1) {
    encrypted[index] ^= key[index % key.length]
  }
  let text = Buffer.from(pako.inflate(encrypted)).toString()
  text = text.replace(/\r/g, '').replace(/^.*\[id:\$\w+\]\n/, '')
  let translation: string[][] | undefined
  let romanization: string[][] | undefined
  const language = /\[language:([\w=\\/+]+)\]/.exec(text)
  if (language) {
    text = text.replace(/\[language:[\w=\\/+]+\]\n?/, '')
    const data = JSON.parse(Buffer.from(language[1], 'base64').toString()) as {
      content?: Array<{ type: number; lyricContent: string[][] }>
    }
    for (const item of data.content ?? []) {
      if (item.type === 0) romanization = item.lyricContent
      if (item.type === 1) translation = item.lyricContent
    }
  }
  let lineIndex = 0
  const translationLines: string[] = []
  const romanizationLines: string[] = []
  let lxlyric = text.replace(/\[((\d+),\d+)\].*/g, (line, range, start) => {
    const time = Number(start)
    const timestamp = formatLrcTime(time / 1_000)
    if (translation) {
      translationLines.push(`[${timestamp}]${translation[lineIndex]?.join('') ?? ''}`)
    }
    if (romanization) {
      romanizationLines.push(`[${timestamp}]${romanization[lineIndex]?.join('') ?? ''}`)
    }
    lineIndex += 1
    return line.replace(range, timestamp)
  })
  lxlyric = decodeHtml(lxlyric.replace(/<(\d+,\d+),\d+>/g, '<$1>'))
  return {
    lyric: lxlyric.replace(/<\d+,\d+>/g, ''),
    tlyric: decodeHtml(translationLines.join('\n')),
    rlyric: decodeHtml(romanizationLines.join('\n')),
    lxlyric,
  }
}

const getKugouLyrics = async (
  track: MusicTrack,
  settings: AppSettings,
): Promise<LyricPayload> => {
  const duration = track._interval || 0
  const search = await requestJson<{
    candidates?: Array<{
      id: string
      accesskey: string
      krctype: number
      contenttype: number
    }>
  }>(
    `http://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(
      track.name,
    )}&hash=${encodeURIComponent(track.hash ?? '')}&timelength=${duration}&lrctxt=1`,
    settings,
    {
      headers: {
        'KG-RC': '1',
        'KG-THash': 'expand_search_manager.cpp:852736169:451',
        'User-Agent': 'KuGou2012-9020-ExpandSearchManager',
      },
    },
  )
  const candidate = search.candidates?.[0]
  if (!candidate) throw new Error('未找到歌词')
  const format =
    candidate.krctype === 1 && candidate.contenttype !== 1 ? 'krc' : 'lrc'
  const result = await requestJson<{ fmt?: string; content?: string }>(
    `http://lyrics.kugou.com/download?ver=1&client=pc&id=${candidate.id}&accesskey=${candidate.accesskey}&fmt=${format}&charset=utf8`,
    settings,
    {
      headers: {
        'KG-RC': '1',
        'KG-THash': 'expand_search_manager.cpp:852736169:451',
        'User-Agent': 'KuGou2012-9020-ExpandSearchManager',
      },
    },
  )
  if (!result.content) throw new Error('歌词内容为空')
  if (result.fmt === 'krc') return decodeKrc(result.content)
  return { lyric: Buffer.from(result.content, 'base64').toString('utf8') }
}

const getTencentLyrics = async (
  track: MusicTrack,
  settings: AppSettings,
): Promise<LyricPayload> => {
  const data = await requestJson<{
    lyric?: string
    trans?: string
  }>(
    `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(
      String(track.songmid),
    )}&format=json&nobase64=1`,
    settings,
    {
      headers: {
        Referer: 'https://y.qq.com/',
        'User-Agent': 'Mozilla/5.0',
      },
    },
  )
  if (!data.lyric) throw new Error('未找到歌词')
  return {
    lyric: decodeHtml(data.lyric),
    tlyric: decodeHtml(data.trans),
  }
}

const getNeteaseLyrics = async (
  track: MusicTrack,
  settings: AppSettings,
): Promise<LyricPayload> => {
  const data = await requestJson<{
    lrc?: { lyric?: string }
    tlyric?: { lyric?: string }
    romalrc?: { lyric?: string }
    klyric?: { lyric?: string }
  }>(
    `https://music.163.com/api/song/lyric?id=${encodeURIComponent(
      String(track.songmid),
    )}&lv=-1&kv=-1&tv=-1&rv=-1`,
    settings,
    {
      headers: {
        Referer: 'https://music.163.com/',
        'User-Agent': 'Mozilla/5.0',
      },
    },
  )
  if (!data.lrc?.lyric) throw new Error('未找到歌词')
  return {
    lyric: data.lrc.lyric,
    tlyric: data.tlyric?.lyric,
    rlyric: data.romalrc?.lyric,
    lxlyric: data.klyric?.lyric,
  }
}

const getMiguLyrics = async (
  track: MusicTrack,
  settings: AppSettings,
): Promise<LyricPayload> => {
  if (!track.lrcUrl) throw new Error('当前结果没有普通歌词地址')
  const headers = {
    Referer: 'https://app.c.nf.migu.cn/',
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 11; Mobile) AppleWebKit/537.36',
    channel: '0146921',
  }
  const lyric = await requestText(track.lrcUrl, settings, { headers })
  const tlyric = track.trcUrl
    ? await requestText(track.trcUrl, settings, { headers }).catch(() => '')
    : ''
  return { lyric, tlyric }
}

export const getBuiltinLyrics = (
  track: MusicTrack,
  settings: AppSettings,
) => {
  switch (track.source) {
    case 'kw':
      return getKuwoLyrics(track, settings)
    case 'kg':
      return getKugouLyrics(track, settings)
    case 'tx':
      return getTencentLyrics(track, settings)
    case 'wy':
      return getNeteaseLyrics(track, settings)
    case 'mg':
      return getMiguLyrics(track, settings)
    case 'local':
      return Promise.reject(new Error('本地歌曲歌词需要由自定义源提供'))
  }
}

export const getBuiltinArtwork = async (
  track: MusicTrack,
  settings: AppSettings,
) => {
  if (track.img) return track.img
  if (track.source === 'kw') {
    const value = await requestText(
      `http://artistpicserver.kuwo.cn/pic.web?corp=kuwo&type=rid_pic&pictype=500&size=500&rid=${encodeURIComponent(
        String(track.songmid),
      )}`,
      settings,
    )
    return /^https?:/i.test(value.trim()) ? value.trim() : null
  }
  return null
}

