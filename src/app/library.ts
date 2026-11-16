import { loadProject, newId, normaliseProject, STORAGE_KEY, type Project } from './project'

/**
 * Every project kept in this browser. Each project lives under its own key so switching or
 * autosaving touches one project, not all of them; the index holds just enough to list them.
 */
export interface LibraryEntry {
  id: string
  name: string
  /** ISO timestamp of the last edit, for "most recent first" ordering. */
  updatedAt: string
}

export interface Library {
  activeId: string
  entries: LibraryEntry[]
}

export const LIBRARY_KEY = 'scheduleMaker.library.v1'
export const projectKey = (id: string) => `scheduleMaker.project.${id}`

type ReadStorage = Pick<Storage, 'getItem'>
type WriteStorage = Pick<Storage, 'setItem' | 'removeItem'>

/** Most recently edited first. */
export const recentFirst = (entries: readonly LibraryEntry[]): LibraryEntry[] =>
  [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

function readIndex(storage: ReadStorage): LibraryEntry[] | null {
  const text = storage.getItem(LIBRARY_KEY)
  if (!text) return null
  const raw = JSON.parse(text) as { entries?: unknown }
  if (!Array.isArray(raw.entries)) return null
  return raw.entries.filter(
    (e): e is LibraryEntry =>
      typeof e === 'object' && e !== null && typeof e.id === 'string' && typeof e.name === 'string' && typeof e.updatedAt === 'string',
  )
}

export function loadLibraryProject(storage: ReadStorage | undefined, id: string): Project | null {
  try {
    const text = storage?.getItem(projectKey(id))
    return text ? normaliseProject(JSON.parse(text)) : null
  } catch {
    return null
  }
}

/**
 * The library and its active project, or `null` when this browser has nothing saved. A save from
 * before the library existed (a single project under {@link STORAGE_KEY}) comes back as a library
 * of one, unsaved until the first autosave writes it in the new layout.
 */
export function loadLibrary(storage: ReadStorage | undefined, now = new Date()): { library: Library; project: Project } | null {
  if (!storage) return null
  try {
    const entries = readIndex(storage)
    if (entries) {
      const activeId = (JSON.parse(storage.getItem(LIBRARY_KEY)!) as { activeId?: unknown }).activeId
      // Try the active project first, then the rest newest first, skipping any that won't load.
      const order = [...entries.filter((e) => e.id === activeId), ...recentFirst(entries.filter((e) => e.id !== activeId))]
      for (const entry of order) {
        const project = loadLibraryProject(storage, entry.id)
        if (project) return { library: { activeId: entry.id, entries }, project }
      }
      return null
    }
  } catch {
    // A corrupt index falls through to the legacy slot.
  }
  const legacy = loadProject(storage)
  if (!legacy) return null
  const id = newId()
  return { library: { activeId: id, entries: [{ id, name: legacy.name, updatedAt: now.toISOString() }] }, project: legacy }
}

export function saveIndex(storage: WriteStorage | undefined, library: Library): boolean {
  try {
    storage?.setItem(LIBRARY_KEY, JSON.stringify(library))
    return storage !== undefined
  } catch {
    return false
  }
}

export function saveLibraryProject(storage: WriteStorage | undefined, id: string, project: Project): boolean {
  try {
    storage?.setItem(projectKey(id), JSON.stringify(project))
    return storage !== undefined
  } catch {
    return false
  }
}

export function removeLibraryProject(storage: WriteStorage | undefined, id: string): void {
  try {
    storage?.removeItem(projectKey(id))
  } catch {
    // Nothing to do: the index no longer lists it either way.
  }
}

/** Records an edit to a project: its current name and the time. Adds the entry if it's new. */
export function touchEntry(library: Library, id: string, name: string, now = new Date()): Library {
  const entry = { id, name, updatedAt: now.toISOString() }
  const exists = library.entries.some((e) => e.id === id)
  return { ...library, entries: exists ? library.entries.map((e) => (e.id === id ? entry : e)) : [...library.entries, entry] }
}

/** `name`, or `name (2)`, `name (3)`… so a second copy of an example is told apart from the first. */
export function uniqueName(name: string, entries: readonly LibraryEntry[]): string {
  const taken = new Set(entries.map((e) => e.name))
  if (!taken.has(name)) return name
  for (let n = 2; ; n++) if (!taken.has(`${name} (${n})`)) return `${name} (${n})`
}
