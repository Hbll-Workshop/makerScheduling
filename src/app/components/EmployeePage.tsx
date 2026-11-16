import { useState } from 'react'
import { fmtHour } from '../../core/config'
import { Availability, DAY_NAMES, WEEK_HOURS } from '../../core/types'
import { initials } from '../people'
import {
  isOpen,
  newId,
  fillEmptyOpenHours,
  paintGrid,
  setWorking,
  updateEmployee,
  visibleHours,
  type Project,
  type ProjectEmployee,
  type ProjectUpdate,
} from '../project'
import type { EmployeeTab, Route } from '../routes'
import { NumberField } from './NumberField'
import { Callout } from './ui/Callout'
import { Card } from './ui/Card'
import { Icon } from './ui/Icon'
import { Segmented } from './ui/Segmented'
import { WeekGrid } from './WeekGrid'

const LEVELS: { value: Availability; label: string }[] = [
  { value: Availability.Preferred, label: 'Preferred' },
  { value: Availability.NotPreferred, label: 'Not preferred' },
  { value: Availability.Unavailable, label: 'Unavailable' },
]

const levelName = (value: number) => LEVELS.find((l) => l.value === value)?.label ?? 'Unavailable'

const TABS: { id: EmployeeTab; label: string }[] = [
  { id: 'details', label: 'Details' },
  { id: 'availability', label: 'Availability' },
]

interface EmployeePageProps {
  project: Project
  update: ProjectUpdate
  navigate: (route: Route) => void
  id: string
  tab: EmployeeTab
}

/** One person, one concern at a time: their details, or when they can work. */
export function EmployeePage({ project, update, navigate, id, tab }: EmployeePageProps) {
  const employee = project.employees.find((e) => e.id === id)
  const back = () => navigate({ page: 'employees' })

  if (!employee) {
    return (
      <Card title="Employee not found" description="They may have been deleted.">
        <div>
          <button type="button" className="btn" onClick={back}>
            <Icon name="arrowLeft" size={14} /> All employees
          </button>
        </div>
      </Card>
    )
  }

  const working = employee.working

  return (
    <div className="stack">
      <div className="page-head">
        <button type="button" className="btn btn--ghost btn--sm back-link" onClick={back}>
          <Icon name="arrowLeft" size={14} /> All employees
        </button>
        <div className="page-title-row">
          <span className="avatar avatar--lg" aria-hidden="true">{initials(employee.name)}</span>
          <h1 className="page-title">{employee.name || 'Unnamed'}</h1>
          {!working && <span className="pill">Not on the schedule</span>}
        </div>
        <nav className="subtabs" aria-label={`${employee.name} sections`}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className="subtab"
              aria-current={t.id === tab ? 'page' : undefined}
              onClick={() => navigate({ page: 'employee', id: employee.id, tab: t.id })}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Keyed so a half-filled form resets when another employee is opened. */}
      {tab === 'details' && <DetailsTab key={employee.id} update={update} employee={employee} working={working} navigate={navigate} />}
      {tab === 'availability' && <AvailabilityTab project={project} update={update} employee={employee} />}
    </div>
  )
}

interface TabProps {
  project: Project
  update: ProjectUpdate
  employee: ProjectEmployee
}

function DetailsTab({ update, employee, working, navigate }: Omit<TabProps, "project"> & { working: boolean; navigate: (route: Route) => void }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const duplicate = () => {
    const copy = { ...employee, id: newId(), name: `${employee.name} (copy)`, availability: employee.availability.slice() }
    update((p) => ({ ...p, employees: [...p.employees, copy] }))
    navigate({ page: 'employee', id: copy.id, tab: 'details' })
  }

  const remove = () => {
    update((p) => ({ ...p, employees: p.employees.filter((e) => e.id !== employee.id) }))
    navigate({ page: 'employees' })
  }

  return (
    <>
      <Card title="Details">
        <label className="field">
          <span>Name</span>
          <input type="text" value={employee.name} onChange={(e) => update((p) => updateEmployee(p, employee.id, { name: e.target.value }))} />
        </label>
        <div className="fields">
          <NumberField label="Target hours / week" value={employee.targetWeeklyHours} min={0} max={168} onChange={(v) => update((p) => updateEmployee(p, employee.id, { targetWeeklyHours: v }))} />
          <NumberField label="Max hours / week" value={employee.maxWeeklyHours} min={0} max={168} onChange={(v) => update((p) => updateEmployee(p, employee.id, { maxWeeklyHours: v }))} />
        </div>
        <label className="toggle">
          <input type="checkbox" role="switch" className="switch" checked={working} onChange={(e) => update((p) => setWorking(p, employee.id, e.target.checked))} />
          <span className="toggle-text">
            <span className="toggle-label">On the schedule</span>
            <span className="toggle-hint">Off keeps them on the team without scheduling them.</span>
          </span>
        </label>
      </Card>

      <Card title="Other actions">
        <div className="row">
          <button type="button" className="btn" onClick={duplicate}>
            <Icon name="copy" size={14} /> Duplicate
          </button>
          <button type="button" className="btn btn--danger" onClick={() => setConfirmingDelete(true)}>
            <Icon name="trash" size={14} /> Delete…
          </button>
        </div>
        {confirmingDelete && (
          <Callout
            tone="critical"
            title={`Delete ${employee.name || 'this employee'}?`}
            actions={
              <>
                <button type="button" className="btn btn--sm btn--danger-solid" onClick={remove}>Delete</button>
                <button type="button" className="btn btn--sm" onClick={() => setConfirmingDelete(false)}>Keep</button>
              </>
            }
          >
            <p className="hint">Their availability goes with them. Saved schedules keep their name. You can undo this.</p>
          </Callout>
        )}
      </Card>
    </>
  )
}

function AvailabilityTab({ project, update, employee }: TabProps) {
  const [brush, setBrush] = useState<Availability>(Availability.Preferred)
  const paint = (slots: Iterable<number>, value: number) =>
    update((p) => {
      const current = p.employees.find((e) => e.id === employee.id)
      return current ? updateEmployee(p, employee.id, { availability: paintGrid(current.availability, slots, value) }) : p
    })

  return (
    <Card
      title="Availability"
      description="When they can work each week. Pick a brush, then click or drag across the grid."
      info="Faded hours are outside your opening hours and never get scheduled."
    >
      <div className="toolbar">
        <Segmented
          label="Availability brush"
          value={brush}
          onChange={setBrush}
          options={LEVELS.map((level) => ({
            value: level.value,
            label: (
              <>
                <span className={`swatch avail-${level.value}`} /> {level.label}
              </>
            ),
          }))}
        />
        <div className="toolbar-actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            title="Fills open hours that aren't marked yet. Hours you've already set stay as they are."
            disabled={brush === Availability.Unavailable}
            onClick={() => update((p) => {
              const current = p.employees.find((e) => e.id === employee.id)
              return current ? updateEmployee(p, employee.id, { availability: fillEmptyOpenHours(p, current.availability, brush) }) : p
            })}
          >
            Fill empty open hours with {levelName(brush).toLowerCase()}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => update((p) => updateEmployee(p, employee.id, { availability: new Array<number>(WEEK_HOURS).fill(Availability.Unavailable) }))}
          >
            Clear
          </button>
        </div>
      </div>

      <WeekGrid
        label={`${employee.name} availability`}
        hours={visibleHours(project)}
        onPaint={(slot) => paint([slot], brush)}
        describe={(slot, day, hour) => {
          const value = employee.availability[slot]
          const open = isOpen(project, day, hour)
          return {
            className: `avail-${value}${open ? '' : ' avail-outside'}`,
            title: `${DAY_NAMES[day]} ${fmtHour(hour)}: ${levelName(value)}${open ? '' : ' (closed)'}`,
          }
        }}
      />

      <div className="legend">
        {LEVELS.map((level) => (
          <span key={level.value} className="legend-item">
            <span className={`swatch avail-${level.value}`} /> {level.label}
          </span>
        ))}
      </div>
    </Card>
  )
}
