import { isTauri } from '@tauri-apps/api/core'
import { useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { openExternalUrl } from '../lib/tauri'

export function UpdateNotes({ children, className = '' }: { children: string; className?: string }) {
  const [linkError, setLinkError] = useState('')

  return (
    <div className={`update-notes ${className}`.trim()}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ children, href, title }) => (
            <a
              href={href}
              title={title}
              target="_blank"
              rel="noopener noreferrer"
              onClick={async (event) => {
                if (!href || !isTauri()) return
                event.preventDefault()
                setLinkError('')
                try {
                  await openExternalUrl(href)
                } catch {
                  setLinkError('无法打开链接，请稍后重试。')
                }
              }}
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="update-notes-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {children}
      </Markdown>
      {linkError && <p className="update-notes-link-error" role="status">{linkError}</p>}
    </div>
  )
}
