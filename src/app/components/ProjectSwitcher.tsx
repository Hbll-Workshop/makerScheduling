import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { recentFirst, type LibraryEntry } from '../library'
import { Icon } from './ui/Icon'

interface ProjectSwitcherProps {
  entries: readonly LibraryEntry[]
  activeId: string
  onSwitch: (id: string) => void
  onNew: () => void
  onDelete: (entry: LibraryEntry) => void
}

function edited(iso: string, now = new Date()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const minutes = Math.round((now.getTime() - date.getTime()) / 60000)
  if (minutes < 1) return 'Edited just now'
  if (minutes < 60) return `Edited ${minutes} min ago`
  if (minutes < 60 * 24 && date.getDate() === now.getDate()) return `Edited today`
  return `Edited ${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric' })}`
}

const focusables = (list: HTMLElement | null) => Array.from(list?.querySelectorAll<HTMLElement>('button') ?? [])

/** Opens a list of every project in this browser: pick one to switch, or delete one. */
export function ProjectSwitcher({ entries, activeId, onSwitch, onNew, onDelete }: ProjectSwitcherProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    panel.current?.querySelector<HTMLElement>('.project-row.is-active .project-row-main')?.focus()
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const close = () => {
    setOpen(false)
    button.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      return close()
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const all = focusables(panel.current)
    const at = all.indexOf(document.activeElement as HTMLElement)
    all[(at + (event.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus()
  }

  const sorted = recentFirst(entries)

  return (
    <div className="project-switcher" ref={root}>
      <button
        ref={button}
        type="button"
        className="btn btn--ghost btn--icon btn--sm"
        aria-label="Switch project"
        title={`Switch project (${entries.length} saved)`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="chevronsUpDown" />
      </button>
      {open && (
        <div ref={panel} className="project-panel" role="dialog" aria-label="Projects" onKeyDown={onKeyDown}>
          <div className="menu-heading section-label">Projects in this browser</div>
          <ul className="project-list">
            {sorted.map((entry) => {
              const active = entry.id === activeId
              return (
                <li key={entry.id} className={`project-row${active ? ' is-active' : ''}`}>
                  <button
                    type="button"
                    className="project-row-main"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => {
                      setOpen(false)
                      if (!active) onSwitch(entry.id)
                    }}
                  >
                    <span className="project-row-check">{active && <Icon name="check" size={14} />}</span>
                    <span className="project-row-text">
                      <span className="project-row-name">{entry.name || 'Untitled'}</span>
                      <span className="project-row-meta">{edited(entry.updatedAt)}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon btn--sm project-row-delete"
                    aria-label={`Delete ${entry.name || 'Untitled'}`}
                    title="Delete project"
                    onClick={() => {
                      setOpen(false)
                      onDelete(entry)
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </li>
              )
            })}
          </ul>
          <div className="menu-separator" role="separator" />
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setOpen(false)
              onNew()
            }}
          >
            <Icon name="filePlus" /> New project
          </button>
        </div>
      )}
    </div>
  )
}
