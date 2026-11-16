import { colorSlots, initials, personClass } from '../people'
import { newEmployee, setWorking, workingEmployees, type Project, type ProjectUpdate } from '../project'
import type { Route } from '../routes'
import { Card } from './ui/Card'
import { Icon } from './ui/Icon'

interface EmployeesPageProps {
  project: Project
  update: ProjectUpdate
  navigate: (route: Route) => void
}

/** Step 1: who is on the schedule. Everything else about a person is one click away. */
export function EmployeesPage({ project, update, navigate }: EmployeesPageProps) {
  const working = workingEmployees(project).length
  const slots = colorSlots(project, project.employees.map((e) => e.id))

  const add = () => {
    const employee = newEmployee(project)
    update((p) => ({ ...p, employees: [...p.employees, employee] }))
    navigate({ page: 'employee', id: employee.id, tab: 'details' })
  }

  return (
    <div className="stack">
      <Card
        title="Who's working?"
        description="Untick anyone who shouldn't be on the schedule. Open someone to change their details or availability."
        actions={
          <button type="button" className="btn btn--sm" onClick={add}>
            <Icon name="plus" size={14} /> New employee
          </button>
        }
        flush={project.employees.length > 0}
      >
        {project.employees.length === 0 ? (
          <div className="row">
            <p className="hint">No employees yet.</p>
            <button type="button" className="btn btn--primary" onClick={add}>
              <Icon name="plus" size={14} /> Add your first employee
            </button>
          </div>
        ) : (
          <>
            <ul className="people-list">
              {project.employees.map((e, i) => {
                const isWorking = e.working
                return (
                  <li key={e.id} className={`people-row${isWorking ? '' : ' is-out'}`}>
                    <label className="people-check">
                      <input
                        type="checkbox"
                        checked={isWorking}
                        aria-label={`${e.name || 'Unnamed'} is on the schedule`}
                        onChange={(event) => update((p) => setWorking(p, e.id, event.target.checked))}
                      />
                      <span className={`avatar ${personClass(slots[i])}`} aria-hidden="true">{initials(e.name)}</span>
                      <span className="people-text">
                        <span className="people-name">{e.name || 'Unnamed'}</span>
                        <span className="people-meta">
                          {isWorking ? `${e.targetWeeklyHours}h target · up to ${e.maxWeeklyHours}h` : 'Not on the schedule'}
                        </span>
                      </span>
                    </label>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => navigate({ page: 'employee', id: e.id, tab: 'details' })}
                    >
                      Open <Icon name="chevronRight" size={14} />
                    </button>
                  </li>
                )
              })}
            </ul>
            <p className="people-summary hint">
              {working} of {project.employees.length} on the schedule
            </p>
          </>
        )}
      </Card>
    </div>
  )
}
