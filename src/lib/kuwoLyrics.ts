import { Buffer } from 'buffer'
import pako from 'pako'
import type { LyricPayload } from '../types'

const KUWO_HEADER = Buffer.from('\r\n\r\n')
const KUWO_KEY = Buffer.from('yeelion')
const TIME_TAG = /^((?:\[\d{1,3}:\d{1,2}(?:\.\d+)?])+)(.*)$/
const WORD_TIME_TAG = /<-?\d+,-?\d+(?:,-?\d+)?>/g

const decodePayload = (rawBase64: string) => {
  const raw = Buffer.from(rawBase64, 'base64')
  if (raw.subarray(0, 10).toString('utf8').toLowerCase() !== 'tp=content') {
    throw new Error('酷我歌词响应格式不正确')
  }
  const headerEnd = raw.indexOf(KUWO_HEADER)
  if (headerEnd < 0) throw new Error('酷我歌词响应缺少数据段')

  const header = raw.subarray(0, headerEnd).toString('utf8')
  const inflated = Buffer.from(pako.inflate(raw.subarray(headerEnd + KUWO_HEADER.length)))
  // Kuwo can return ordinary LRC even when lrcx=1 was requested.
  if (/(?:^|\r?\n)lrcx=0(?:\r?\n|$)/i.test(header)) {
    return inflated.toString('utf8')
  }
  const encrypted = Buffer.from(inflated.toString('utf8').trim(), 'base64')
  for (let index = 0; index < encrypted.length; index += 1) {
    encrypted[index] ^= KUWO_KEY[index % KUWO_KEY.length]
  }
  return encrypted.toString('utf8')
}

export const decodeKuwoLyrics = (rawBase64: string): LyricPayload => {
  const decoded = decodePayload(rawBase64).replace(
    /\[(\d{1,3}):(\d{1,2}):(\d+)]/g,
    '[$1:$2.$3]',
  )
  const primary: string[] = []
  const translation: string[] = []
  const seenTimes = new Set<string>()

  for (const rawLine of decoded.split(/\r?\n/)) {
    const match = TIME_TAG.exec(rawLine.trim())
    if (!match) continue
    const text = match[2].replace(WORD_TIME_TAG, '').trim()
    if (!text) continue
    for (const time of match[1].match(/\[[^\]]+]/g) ?? []) {
      const line = `${time}${text}`
      if (seenTimes.has(time)) translation.push(line)
      else {
        seenTimes.add(time)
        primary.push(line)
      }
    }
  }

  if (!primary.length) throw new Error('酷我歌词内容为空')
  return {
    lyric: primary.join('\n'),
    tlyric: translation.join('\n'),
  }
}
