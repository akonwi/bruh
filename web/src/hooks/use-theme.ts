import { useCallback, useEffect, useState } from 'react'

export type Theme = 'light' | 'dark' | 'system'

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(theme: Theme) {
  const resolved = theme === 'system' ? getSystemTheme() : theme
  document.documentElement.classList.toggle('dark', resolved === 'dark')
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem('theme') as Theme | null
    return stored ?? 'system'
  })

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    if (next === 'system') {
      localStorage.removeItem('theme')
    } else {
      localStorage.setItem('theme', next)
    }
    applyTheme(next)
  }, [])

  // Listen for system theme changes when in 'system' mode
  useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => applyTheme('system')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  // Apply on mount
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const resolvedTheme = theme === 'system' ? getSystemTheme() : theme

  return { theme, setTheme, resolvedTheme }
}
