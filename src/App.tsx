import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { CoveragePage } from './app/components/CoveragePage'
import { EmployeePage } from './app/components/EmployeePage'
import { EmployeesPage } from './app/components/EmployeesPage'
import { SchedulePanel } from './app/components/SchedulePanel'
import { ProjectSwitcher } from './app/components/ProjectSwitcher'
import { SettingsPage } from './app/components/SettingsPage'
import { SolvePanel } from './app/components/SolvePanel'
import { StepFooter, Stepper } from './app/components/Stepper'
import { Callout } from './app/components/ui/Callout'
import { ConfirmDialog } from './app/components/ui/ConfirmDialog'
import { Icon, LogoMark } from './app/components/ui/Icon'
import { Menu } from './app/components/ui/Menu'
import { TeamPanel } from './app/components/TeamPanel'
import { WeekSwitcher } from './app/components/WeekSwitcher'
import { downloadFile } from './app/download'
import {
  loadLibrary,
  loadLibraryProject,
  removeLibraryProject,
  saveIndex,
  saveLibraryProject,
  touchEntry,
  uniqueName,
  type Library,
  type LibraryEntry,
} from './app/library'
import {
  newId,
  normaliseProject,
  projectFromScenario,
  projectProblems,
  projectToScenario,
  saveWeekSchedule,
  setWeekStart,
  solveKey,
  type Project,
  type ProjectUpdate,
} from './app/project'
import { stepOf, stepRoute, useRoute } from './app/routes'
import { STEPS, stepStates, type StepId } from './app/steps'
import { useTheme } from './app/theme'
import { useSolver, type SolvedRun } from './app/useSolver'
import { useUndoable } from './app/useUndoable'
import { addDays, todayIso } from './core/calendar'
import { parseScenario, serializeScenario, type ScenarioJson } from './core/io'
import mediumShop from './fixtures/medium-shop.json'
import smallCafe from './fixtures/small-cafe.json'

const EXAMPLES: Record<string, { label: string; json: ScenarioJson }> = {
  'small-cafe': { label: 'Small Cafe (3 people)', json: smallCafe as unknown as ScenarioJson },
  'medium-shop': { label: 'Medium Shop (8 people)', json: mediumShop as unknown as ScenarioJson },
}

const BLANK: ScenarioJson = {
  name: 'New schedule',
  config: {
    operatingHours: { Mon: [9, 17], Tue: [9, 17], Wed: [9, 17], Thu: [9, 17], Fri: [9, 17] },
    minCoverage: 1,
  },
  employees: [],
}

/** `localStorage` can be absent or throw on access (private windows, blocked site data). */
function storage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

const slug = (name: string) => name.trim().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'schedule'

/** Text fields keep their own Ctrl+Z; the project-wide shortcut must not steal it. */
const isTextEntry = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  target.closest('textarea, select, [contenteditable="true"], input:not([type="checkbox"]):not([type="radio"]):not([type="button"])') !== null

const blankProject = () => projectFromScenario(parseScenario(BLANK))

export function App() {
  const [initial] = useState(() => {
    const stored = loadLibrary(storage())
    if (stored) return { ...stored, fresh: false }
    const project = projectFromScenario(parseScenario(EXAMPLES['small-cafe'].json))
    const id = newId()
    const library: Library = { activeId: id, entries: [{ id, name: project.name, updatedAt: new Date().toISOString() }] }
    return { library, project, fresh: true }
  })
  const history = useUndoable(() => initial.project)
  const project = history.value
  const update: ProjectUpdate = history.update
  const [library, setLibrary] = useState(initial.library)
  const activeId = library.activeId
  /** The project as it was opened; saving it unchanged doesn't count as an edit. */
  const opened = useRef<Project>(initial.project)

  const [route, navigate] = useRoute()
  const [theme, toggleTheme] = useTheme(storage())
  const step = stepOf(route)
  const [exploringExample, setExploringExample] = useState(initial.fresh)
  const [newWeek, setNewWeek] = useState(false)
  const [deleting, setDeleting] = useState<LibraryEntry | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const solver = useSolver()

  const problems = useMemo(() => projectProblems(project), [project])
  const freshResults = solver.result !== null && solveKey(solver.result.project) === solveKey(project)
  const states = stepStates(project, freshResults, problems)

  const persist = useCallback((id: string, p: Project) => {
    setSaveFailed(!saveLibraryProject(storage(), id, p))
    if (p !== opened.current) setLibrary((lib) => touchEntry(lib, id, p.name))
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => persist(activeId, project), 300)
    return () => window.clearTimeout(timer)
  }, [project, activeId, persist])

  useEffect(() => {
    saveIndex(storage(), library)
  }, [library])

  const { undo, redo } = history
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || isTextEntry(event.target)) return
      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return
      event.preventDefault()
      if (key === 'y' || event.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo])

  const goTo = useCallback((next: StepId) => navigate(stepRoute(next)), [navigate])

  // The new-week prompt belongs to the first page of the new week only.
  useEffect(() => {
    if (route.page !== 'employees') setNewWeek(false)
  }, [route.page])

  /** Makes `next` the open project. `keepCurrent` saves the outgoing one first (skipped when it was just deleted). */
  const openProject = (id: string, next: Project, keepCurrent: boolean) => {
    if (keepCurrent) persist(activeId, project)
    opened.current = next
    history.reset(next)
    setLibrary((lib) => ({ ...lib, activeId: id }))
    solver.reset()
    setFileError(null)
    setExploringExample(false)
    setNewWeek(false)
    navigate({ page: 'employees' })
  }

  const createProject = (base: Project, keepCurrent = true) => {
    const id = newId()
    const next = { ...base, name: uniqueName(base.name, library.entries.filter((e) => e.id !== deleting?.id)) }
    saveLibraryProject(storage(), id, next)
    setLibrary((lib) => touchEntry(lib, id, next.name))
    openProject(id, next, keepCurrent)
  }

  const switchProject = (id: string) => {
    const next = loadLibraryProject(storage(), id)
    if (next) openProject(id, next, true)
    else setFileError(`That project couldn't be loaded from this browser's storage. It may be damaged; you can delete it from the project list.`)
  }

  const confirmDelete = () => {
    if (!deleting) return
    const gone = deleting
    setDeleting(null)
    removeLibraryProject(storage(), gone.id)
    setLibrary((lib) => ({ ...lib, entries: lib.entries.filter((e) => e.id !== gone.id) }))
    if (gone.id !== activeId) return
    // Open the most recent project that still loads, or start a blank one if none is left.
    const rest = library.entries.filter((e) => e.id !== gone.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    for (const entry of rest) {
      const next = loadLibraryProject(storage(), entry.id)
      if (next) return openProject(entry.id, next, false)
    }
    createProject(blankProject(), false)
  }

  const saveBackup = () =>
    downloadFile(`${slug(project.name)}-backup-${todayIso()}.json`, JSON.stringify(project, null, 2), 'application/json')

  const exportScenario = () =>
    downloadFile(`${slug(project.name)}.json`, JSON.stringify(serializeScenario(projectToScenario(project)), null, 2), 'application/json')

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const raw = JSON.parse(await file.text()) as unknown
      const asProject = normaliseProject(raw)
      createProject(asProject ?? projectFromScenario(parseScenario(raw as ScenarioJson), project.search))
    } catch (error) {
      setFileError(`Couldn't read ${file.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const adoptSchedule = (run: SolvedRun, index: number) => {
    update((p) => saveWeekSchedule(p, run.project, run.schedules[index]))
    goTo('schedule')
  }

  const startNextWeek = () => {
    update((p) => setWeekStart(p, addDays(p.weekStart, 7)))
    navigate({ page: 'employees' })
    setNewWeek(true)
  }

  return (
    <>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark"><LogoMark size={16} /></span>
            <span className="brand-name">Schedule Maker</span>
          </div>
          <div className="project-bar">
            <input
              type="text"
              className="project-name"
              aria-label="Project name"
              value={project.name}
              onChange={(e) => {
                const name = e.target.value
                update((p) => ({ ...p, name }))
              }}
            />
            <ProjectSwitcher
              entries={library.entries}
              activeId={activeId}
              onSwitch={switchProject}
              onNew={() => createProject(blankProject())}
              onDelete={setDeleting}
            />
          </div>
          <Stepper current={step} states={states} onSelect={goTo} />
          <TeamPanel project={project} route={route} navigate={navigate} />
          <div className="sidebar-foot">
            {saveFailed ? (
              <span className="pill pill--warning" title="This browser isn't saving changes (storage is blocked). Save a backup file to keep your work.">
                <Icon name="alert" size={12} /> Not saving · save a backup
              </span>
            ) : (
              <span className="save-status save-status--ok" title="Changes are saved in this browser automatically">
                <Icon name="check" size={12} /> Saved
              </span>
            )}
            <span className="spacer" />
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--sm"
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              onClick={toggleTheme}
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            </button>
            <button
              type="button"
              className={`btn btn--ghost btn--icon btn--sm${route.page === 'settings' ? ' is-active' : ''}`}
              aria-label="Settings"
              title="Settings: shift rules and priorities"
              aria-current={route.page === 'settings' ? 'page' : undefined}
              onClick={() => navigate({ page: 'settings', tab: 'shifts' })}
            >
              <Icon name="settings" />
            </button>
            <Menu
              label="Project"
              trigger={<>Project <Icon name="chevronDown" size={14} /></>}
              triggerClassName="btn btn--sm"
              entries={[
                { label: 'New project', icon: 'filePlus', onSelect: () => createProject(blankProject()) },
                'separator',
                { label: 'Save backup file', icon: 'download', onSelect: saveBackup },
                { label: 'Open backup file…', icon: 'upload', onSelect: () => fileInput.current?.click() },
                { label: 'Export for command line', icon: 'download', onSelect: exportScenario },
                'separator',
                {
                  label: 'Delete this project…',
                  icon: 'trash',
                  danger: true,
                  onSelect: () => setDeleting(library.entries.find((e) => e.id === activeId) ?? { id: activeId, name: project.name, updatedAt: '' }),
                },
                'separator',
                { heading: 'Open an example' },
                ...Object.values(EXAMPLES).map((example) => ({
                  label: example.label,
                  icon: 'sparkle' as const,
                  onSelect: () => createProject(projectFromScenario(parseScenario(example.json))),
                })),
              ]}
            />
            <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={importFile} />
          </div>
        </aside>

        <div className="workspace">
          <header className="workspace-head">
            {step && <h1 className="workspace-title">{STEPS.find((s) => s.id === step)?.label}</h1>}
            <span className="spacer" />
            <WeekSwitcher project={project} update={update} />
            <div className="btn-group history-buttons">
              <button type="button" className="btn btn--icon btn--sm" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!history.canUndo} onClick={undo}>
                <Icon name="undo" />
              </button>
              <button type="button" className="btn btn--icon btn--sm" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!history.canRedo} onClick={redo}>
                <Icon name="redo" />
              </button>
            </div>
          </header>

          <div className="page">
            {exploringExample && route.page === 'employees' && (
              <Callout
                tone="good"
                title="You're exploring an example café"
                actions={
                  <>
                    <button type="button" className="btn btn--sm btn--primary" onClick={() => createProject(blankProject())}>
                      Start my own
                    </button>
                    <button type="button" className="btn btn--sm" onClick={() => setExploringExample(false)}>Keep exploring</button>
                  </>
                }
              >
                <p className="hint">
                  Walk through the four steps above to see how it works. Everything saves in this browser as you go.
                </p>
              </Callout>
            )}
            {fileError && (
              <Callout
                tone="critical"
                role="alert"
                title="Couldn't open that file"
                actions={<button type="button" className="btn btn--sm" onClick={() => setFileError(null)}>Dismiss</button>}
              >
                <p className="hint">{fileError}</p>
              </Callout>
            )}

            <main>
              {route.page === 'employees' && (
                <EmployeesPage project={project} update={update} navigate={navigate} newWeek={newWeek} onDismissNewWeek={() => setNewWeek(false)} />
              )}
              {route.page === 'employee' && <EmployeePage project={project} update={update} navigate={navigate} id={route.id} tab={route.tab} />}
              {route.page === 'coverage' && <CoveragePage project={project} update={update} />}
              {route.page === 'generate' && (
                <SolvePanel project={project} update={update} solver={solver} problems={problems} navigate={navigate} onUseSchedule={adoptSchedule} />
              )}
              {route.page === 'schedule' && <SchedulePanel project={project} update={update} navigate={navigate} onStartNextWeek={startNextWeek} />}
              {route.page === 'settings' && <SettingsPage project={project} update={update} navigate={navigate} tab={route.tab} />}
            </main>

            {/* Back/Next walk the steps; a person's page and Settings are side trips with their own way back. */}
            {step && route.page !== 'employee' && <StepFooter current={step} onSelect={goTo} />}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete “${deleting?.name || 'Untitled'}”?`}
        confirmLabel="Delete project"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      >
        <p className="hint">
          This removes the project and all its saved schedules from this browser. It can't be undone, so save a backup file
          first if you might want it back.
        </p>
      </ConfirmDialog>
    </>
  )
}
