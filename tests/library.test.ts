import { describe, expect, it } from 'vitest'
import {
  LIBRARY_KEY,
  loadLibrary,
  loadLibraryProject,
  projectKey,
  removeLibraryProject,
  saveIndex,
  saveLibraryProject,
  touchEntry,
  uniqueName,
  type Library,
} from '../src/app/library'
import { projectFromScenario, STORAGE_KEY } from '../src/app/project'
import { loadFixture } from './helpers'

const memory = () => {
  const store = new Map<string, string>()
  return {
    store,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
}
const cafe = (name = 'Cafe') => projectFromScenario({ ...loadFixture('small-cafe.json'), name })

describe('project library', () => {
  it('is empty when nothing is saved', () => {
    expect(loadLibrary(memory())).toBeNull()
    expect(loadLibrary(undefined)).toBeNull()
  })

  it('adopts a save from before the library existed', () => {
    const storage = memory()
    storage.setItem(STORAGE_KEY, JSON.stringify(cafe('Old')))
    const loaded = loadLibrary(storage)!
    expect(loaded.project.name).toBe('Old')
    expect(loaded.library.entries).toEqual([expect.objectContaining({ id: loaded.library.activeId, name: 'Old' })])
  })

  it('keeps several projects and reopens the active one', () => {
    const storage = memory()
    let library: Library = { activeId: 'a', entries: [] }
    saveLibraryProject(storage, 'a', cafe('A'))
    saveLibraryProject(storage, 'b', cafe('B'))
    library = touchEntry(touchEntry(library, 'a', 'A'), 'b', 'B')
    saveIndex(storage, { ...library, activeId: 'b' })
    const loaded = loadLibrary(storage)!
    expect(loaded.library.activeId).toBe('b')
    expect(loaded.project.name).toBe('B')
    expect(loadLibraryProject(storage, 'a')!.name).toBe('A')
  })

  it('falls back to another project when the active one is gone', () => {
    const storage = memory()
    saveLibraryProject(storage, 'a', cafe('A'))
    saveIndex(storage, touchEntry(touchEntry({ activeId: 'b', entries: [] }, 'a', 'A'), 'b', 'B'))
    const loaded = loadLibrary(storage)!
    expect(loaded.library.activeId).toBe('a')
  })

  it('deletes a project from storage', () => {
    const storage = memory()
    saveLibraryProject(storage, 'a', cafe())
    removeLibraryProject(storage, 'a')
    expect(storage.store.has(projectKey('a'))).toBe(false)
    expect(loadLibraryProject(storage, 'a')).toBeNull()
  })

  it('treats a corrupt index as missing', () => {
    const storage = memory()
    storage.setItem(LIBRARY_KEY, '{not json')
    expect(loadLibrary(storage)).toBeNull()
  })

  it('renames an entry on edit and numbers duplicate names', () => {
    const lib = touchEntry({ activeId: 'a', entries: [] }, 'a', 'Cafe', new Date(0))
    expect(touchEntry(lib, 'a', 'Bistro').entries).toEqual([expect.objectContaining({ id: 'a', name: 'Bistro' })])
    expect(uniqueName('Cafe', lib.entries)).toBe('Cafe (2)')
    expect(uniqueName('Cafe', [...lib.entries, { id: 'b', name: 'Cafe (2)', updatedAt: '' }])).toBe('Cafe (3)')
    expect(uniqueName('Shop', lib.entries)).toBe('Shop')
  })
})
