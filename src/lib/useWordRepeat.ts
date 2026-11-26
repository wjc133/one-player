import { useCallback, useEffect, useRef, useState } from 'react'

const repeatDelay = 600

function findJapaneseVoice() {
  return window.speechSynthesis.getVoices().find((voice) => voice.lang.toLowerCase().startsWith('ja'))
}

export function useWordRepeat() {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined'
  const [speakingKey, setSpeakingKey] = useState<string | null>(null)
  const [hasJapaneseVoice, setHasJapaneseVoice] = useState(false)
  const [voicesLoaded, setVoicesLoaded] = useState(false)
  const activeKeyRef = useRef<string | null>(null)
  const timerRef = useRef<number | null>(null)
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!supported) return
    const synth = window.speechSynthesis
    const refreshVoices = () => {
      setVoicesLoaded(synth.getVoices().length > 0)
      setHasJapaneseVoice(!!findJapaneseVoice())
    }
    refreshVoices()
    synth.addEventListener('voiceschanged', refreshVoices)
    return () => {
      synth.removeEventListener('voiceschanged', refreshVoices)
      activeKeyRef.current = null
      utteranceRef.current = null
      clearTimer()
      synth.cancel()
    }
  }, [supported, clearTimer])

  const stop = useCallback(() => {
    activeKeyRef.current = null
    utteranceRef.current = null
    clearTimer()
    if (supported) window.speechSynthesis.cancel()
    setSpeakingKey(null)
  }, [supported, clearTimer])

  const toggle = useCallback((key: string, text: string) => {
    if (!supported) return
    if (activeKeyRef.current === key) {
      stop()
      return
    }
    activeKeyRef.current = null
    utteranceRef.current = null
    clearTimer()
    window.speechSynthesis.cancel()
    activeKeyRef.current = key
    setSpeakingKey(key)
    const speak = () => {
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = 'ja-JP'
      const voice = findJapaneseVoice()
      if (voice) utterance.voice = voice
      utterance.onend = () => {
        if (activeKeyRef.current !== key || utteranceRef.current !== utterance) return
        timerRef.current = window.setTimeout(speak, repeatDelay)
      }
      utterance.onerror = (event) => {
        if (event.error === 'interrupted' || event.error === 'canceled') return
        if (activeKeyRef.current !== key || utteranceRef.current !== utterance) return
        activeKeyRef.current = null
        utteranceRef.current = null
        setSpeakingKey(null)
      }
      utteranceRef.current = utterance
      window.speechSynthesis.speak(utterance)
    }
    speak()
  }, [supported, stop, clearTimer])

  return { speakingKey, toggle, stop, supported, hasJapaneseVoice, voicesLoaded }
}
