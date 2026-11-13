import { colorSlots, initials, personClass } from '../people'
import { excludedFor, savedRows, savedScheduleFor, type Project } from '../project'
import type { Route } from '../routes'

interface TeamPanelProps {
  project: Project
  route: Route
  navigate: (route: Route) => void
}

/**
 * The whole roster in the sidebar, in each person's schedule colour. Once the week has a saved
 * schedule, each person shows their hours against their target; before that, just the target.
 */
export function TeamPanel({ project, route, navigate }: TeamPanelProps) {
  const out = new Set(excludedFor(project, project.weekStart))
  const saved = savedScheduleFor(project, project.weekStart)
  const hours = new Map(saved ? savedRows(saved).map((r) => [r.employeeId, r.hours]) : [])
  const slots = colorSlots(project, project.employees.map((e) => e.id))

  return (
    <section className="team" aria-labelledby="team-heading">
      <h2 id="team-heading" className="section-label team-heading">
        Team this week
      </h2>
      {project.employees.length === 0 ? (
        <p className="empty team-empty">No employees yet.</p>
      ) : (
        <ul className="team-list">
          {project.employees.map((e, i) => {
            const isOut = out.has(e.id)
            const worked = hours.get(e.id)
            const active = route.page === 'employee' && route.id === e.id
            const meta = isOut ? 'Off this week' : worked !== undefined ? `${worked}h of ${e.targetWeeklyHours}h` : `${e.targetWeeklyHours}h target`
            return (
              <li key={e.id}>
                <button
                  type="button"
                  className={`team-member ${personClass(slots[i])}${isOut ? ' is-out' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => navigate({ page: 'employee', id: e.id, tab: 'details' })}
                >
                  <span className="team-avatar" aria-hidden="true">{initials(e.name)}</span>
                  <span className="team-text">
                    <span className="team-name">{e.name || 'Unnamed'}</span>
                    <span className="team-meta">{meta}</span>
                  </span>
                  {!isOut && worked !== undefined && e.targetWeeklyHours > 0 && (
                    <span className="team-hours" aria-hidden="true">
                      <span style={{ width: `${Math.min(100, (worked / e.targetWeeklyHours) * 100)}%` }} />
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
