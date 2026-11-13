import { useState } from 'react'
import { ShiftCalendar } from './ShiftCalendar'
import { ShiftTable, type ShiftTableRow } from './ShiftTable'
import { ShiftTimeline } from './ShiftTimeline'
import { Segmented } from './ui/Segmented'

interface ScheduleShiftsProps {
  dayLabels: readonly string[]
  rows: ShiftTableRow[]
  /** Hours the calendar and timeline span; defaults to the span of the shifts. */
  hours?: { from: number; to: number }
}

type View = 'calendar' | 'timeline' | 'table'

/** A schedule's shifts as a week calendar, a timeline or a table, whichever the reader picks. */
export function ScheduleShifts({ dayLabels, rows, hours }: ScheduleShiftsProps) {
  const [view, setView] = useState<View>('calendar')
  return (
    <div className="stack-sm">
      <div className="row">
        <Segmented
          label="Show shifts as"
          options={[
            { value: 'calendar', label: 'Calendar' },
            { value: 'timeline', label: 'Timeline' },
            { value: 'table', label: 'Table' },
          ]}
          value={view}
          onChange={setView}
        />
      </div>
      {view === 'calendar' && <ShiftCalendar dayLabels={dayLabels} rows={rows} hours={hours} />}
      {view === 'timeline' && <ShiftTimeline dayLabels={dayLabels} rows={rows} hours={hours} />}
      {view === 'table' && <ShiftTable dayLabels={dayLabels} rows={rows} />}
    </div>
  )
}
