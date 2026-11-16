import { useState } from 'react'
import { DAY_NAMES } from '../../core/types'
import { downloadFile } from '../download'
import { blockOf, removeSavedSchedule, savedRows, type Project, type ProjectUpdate, type SavedSchedule } from '../project'
import type { Route } from '../routes'
import { scheduleFileName, shiftListCsv, weekGridCsv } from '../scheduleCsv'
import { colorSlots } from '../people'
import { OffDeskPanel } from './OffDeskPanel'
import { ScheduleShifts } from './ScheduleShifts'
import { Card } from './ui/Card'
import { ConfirmDialog } from './ui/ConfirmDialog'
import { Icon } from './ui/Icon'
import { Menu } from './ui/Menu'

const score = (x: number) => String(Number(x.toFixed(2)))

const savedOn = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

interface SchedulePanelProps {
  project: Project
  update: ProjectUpdate
  navigate: (route: Route) => void
}

/** The end of the steps: the chosen weekly schedule, its off-desk hours, and ways to get it out. */
export function SchedulePanel({ project, update, navigate }: SchedulePanelProps) {
  const [removing, setRemoving] = useState(false)
  const saved = project.saved

  if (!saved) {
    return (
      <Card title="No schedule saved yet" description="Generate schedules, then choose “Use this schedule” on the one you want.">
        <div className="row">
          <button type="button" className="btn btn--primary" onClick={() => navigate({ page: 'generate' })}>
            <Icon name="play" size={14} /> Go to Generate
          </button>
        </div>
      </Card>
    )
  }

  const download = (kind: 'grid' | 'shifts') =>
    downloadFile(scheduleFileName(project.name, kind), kind === 'grid' ? weekGridCsv(saved) : shiftListCsv(saved), 'text/csv;charset=utf-8')

  return (
    <div className="stack">
      <Card
        title="Weekly schedule"
        description={`Saved ${savedOn(saved.savedAt)} · score ${score(saved.score)}. The same every week.`}
        actions={
          <Menu
            label="Download the schedule as CSV"
            trigger={
              <>
                <Icon name="download" size={14} /> Download CSV <Icon name="chevronDown" size={14} />
              </>
            }
            triggerClassName="btn btn--primary"
            entries={[
              { label: 'Week grid (one row per person)', icon: 'calendar', onSelect: () => download('grid') },
              { label: 'Shift list (one row per shift)', icon: 'clipboard', onSelect: () => download('shifts') },
            ]}
          />
        }
      >
        <SavedShifts project={project} saved={saved} />
        <div className="row">
          <span className="hint">Want a different one?</span>
          <button type="button" className="btn btn--sm" onClick={() => navigate({ page: 'generate' })}>Generate again</button>
          <span className="spacer" />
          <button type="button" className="btn btn--ghost btn--sm btn--danger" onClick={() => setRemoving(true)}>
            <Icon name="trash" size={14} /> Remove
          </button>
        </div>
      </Card>

      <OffDeskPanel project={project} update={update} navigate={navigate} saved={saved} />

      <ConfirmDialog
        open={removing}
        title="Remove the saved schedule?"
        confirmLabel="Remove"
        onConfirm={() => {
          update(removeSavedSchedule)
          setRemoving(false)
        }}
        onCancel={() => setRemoving(false)}
      >
        <p className="hint">The saved schedule and its off-desk hours will be deleted. You can undo this straight after.</p>
      </ConfirmDialog>
    </div>
  )
}

function SavedShifts({ project, saved }: { project: Project; saved: SavedSchedule }) {
  const slots = colorSlots(project, saved.team.map((m) => m.employeeId))
  return (
    <ScheduleShifts
      dayLabels={DAY_NAMES}
      rows={savedRows(saved).map((row, i) => ({
        key: row.employeeId,
        name: row.employeeName,
        hours: row.hours,
        target: row.targetWeeklyHours,
        slot: slots[i],
        blocks: [...row.shifts.map(blockOf), ...row.offDesk.map((s) => ({ ...blockOf(s), offDesk: true }))],
      }))}
    />
  )
}
