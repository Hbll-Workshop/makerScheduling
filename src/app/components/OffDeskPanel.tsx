import { useState } from 'react'
import { fmtHour, fmtHourRange } from '../../core/config'
import { DAY_NAMES, HOURS_PER_DAY } from '../../core/types'
import {
  addOffDeskShift,
  clearOffDesk,
  offDeskConflict,
  removeOffDeskShift,
  resuggestOffDesk,
  savedRows,
  shiftHours,
  visibleHours,
  type Project,
  type ProjectUpdate,
  type SavedSchedule,
} from '../project'
import type { Route } from '../routes'
import { Callout } from './ui/Callout'
import { Card } from './ui/Card'
import { Icon } from './ui/Icon'

interface OffDeskPanelProps {
  project: Project
  update: ProjectUpdate
  navigate: (route: Route) => void
  saved: SavedSchedule
}

/** A saved week's off-desk hours: budget used, who is still short, and editing. */
export function OffDeskPanel({ project, update, navigate, saved }: OffDeskPanelProps) {
  const budget = project.offDesk.weeklyBudget
  const used = shiftHours(saved.offDesk)
  const rows = savedRows(saved)
  const short = rows.filter((r) => r.hours < r.targetWeeklyHours)

  const { from } = visibleHours(project)
  const [employeeId, setEmployeeId] = useState(rows[0]?.employeeId ?? '')
  const [day, setDay] = useState(0)
  const [startHour, setStartHour] = useState(from)
  const [endHour, setEndHour] = useState(Math.min(from + 3, HOURS_PER_DAY))
  const member = rows.find((r) => r.employeeId === employeeId)
  const draft = { employeeId, day, startHour, endHour }
  const conflict = member ? offDeskConflict(saved, draft) : 'Choose someone.'
  const wouldExceed = conflict === null && used + (endHour - startHour) > budget

  if (budget === 0 && used === 0) {
    return (
      <Card title="Off-desk hours" description="No weekly off-desk budget is set, so none were suggested.">
        <div className="row">
          <button type="button" className="btn btn--sm" onClick={() => navigate({ page: 'settings', tab: 'off-desk' })}>
            <Icon name="settings" size={14} /> Set a budget
          </button>
        </div>
      </Card>
    )
  }

  return (
    <Card
      title="Off-desk hours"
      description={`${used} of ${budget} hours of the weekly budget used. Off-desk hours don't count toward coverage.`}
      actions={
        <>
          <button
            type="button"
            className="btn btn--sm"
            title="Replace these off-desk hours with fresh suggestions"
            onClick={() => update(resuggestOffDesk)}
          >
            <Icon name="sparkle" size={14} /> Suggest again
          </button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={used === 0} onClick={() => update(clearOffDesk)}>
            Clear
          </button>
        </>
      }
    >
      <div className={`off-desk-meter${used > budget ? ' is-over' : ''}`} aria-hidden="true">
        <div style={{ width: `${budget > 0 ? Math.min(100, (used / budget) * 100) : 100}%` }} />
      </div>
      {used > budget && (
        <Callout tone="warning" title={`${used - budget} hours over the weekly budget`}>
          <p className="hint">Remove some off-desk shifts, or raise the budget in Settings.</p>
        </Callout>
      )}
      <p className="hint">
        {short.length === 0
          ? 'Everyone reaches their weekly target.'
          : `Still below target: ${short.map((r) => `${r.employeeName} (−${r.targetWeeklyHours - r.hours}h)`).join(', ')}.`}
        {short.length > 0 && used >= budget && ' The budget is used up.'}
      </p>

      <div className="schedule-scroll">
        <table className="schedule-table">
          <thead>
            <tr>
              <th scope="col">Employee</th>
              <th scope="col" className="num">Desk</th>
              <th scope="col">Off-desk shifts</th>
              <th scope="col" className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const gap = row.targetWeeklyHours - row.hours
              return (
                <tr key={row.employeeId}>
                  <th scope="row">{row.employeeName}</th>
                  <td className="num">{row.deskHours}h</td>
                  <td>
                    {row.offDesk.length === 0 ? (
                      <span className="hint">None</span>
                    ) : (
                      <div className="off-desk-chips">
                        {row.offDesk.map((s) => {
                          const label = `${DAY_NAMES[s.day]} ${fmtHourRange(s.startHour, s.endHour)}`
                          return (
                            <span key={`${s.day}-${s.startHour}`} className="shift-chip is-off-desk">
                              {label}
                              <button
                                type="button"
                                className="off-desk-remove"
                                aria-label={`Remove ${row.employeeName}'s off-desk shift ${label}`}
                                title="Remove"
                                onClick={() => update((p) => removeOffDeskShift(p, row.employeeId, s.day, s.startHour))}
                              >
                                <Icon name="x" size={12} />
                              </button>
                            </span>
                          )
                        })}
                      </div>
                    )}
                  </td>
                  <td className="num">
                    <div>{row.hours}h</div>
                    <div className="hours-target">
                      target {row.targetWeeklyHours}
                      {gap !== 0 && ` (${gap > 0 ? '−' : '+'}${Math.abs(gap)})`}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="stack-sm">
        <h4 className="section-label">Add an off-desk shift</h4>
        <div className="row">
          <select aria-label="Employee" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            {rows.map((r) => (
              <option key={r.employeeId} value={r.employeeId}>{r.employeeName}</option>
            ))}
          </select>
          <select aria-label="Day" value={day} onChange={(e) => setDay(Number(e.target.value))}>
            {DAY_NAMES.map((name, d) => (
              <option key={name} value={d}>{name}</option>
            ))}
          </select>
          <select aria-label="Start" value={startHour} onChange={(e) => setStartHour(Number(e.target.value))}>
            {Array.from({ length: HOURS_PER_DAY }, (_, h) => (
              <option key={h} value={h}>{fmtHour(h)}</option>
            ))}
          </select>
          <span className="hint">to</span>
          <select aria-label="End" value={endHour} onChange={(e) => setEndHour(Number(e.target.value))}>
            {Array.from({ length: HOURS_PER_DAY }, (_, i) => i + 1).map((h) => (
              <option key={h} value={h}>{h === HOURS_PER_DAY ? '12am' : fmtHour(h)}</option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn--sm"
            disabled={conflict !== null || !member}
            onClick={() => member && update((p) => addOffDeskShift(p, { ...draft, employeeName: member.employeeName }))}
          >
            <Icon name="plus" size={14} /> Add
          </button>
        </div>
        {conflict !== null && member && <p className="hint">{conflict}</p>}
        {wouldExceed && <p className="hint">Adding this goes over the weekly budget.</p>}
      </div>
    </Card>
  )
}
