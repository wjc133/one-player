/// <reference types="vite/client" />

interface Window {
  __ONE_PLAYER_STARTUP__: {
    ready: () => void
    fail: (error: unknown) => void
  }
}

