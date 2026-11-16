import { describe, expect, it } from 'vitest'
import {
  addOffDeskShift,
  clearOffDesk,
  normaliseProject,
  offDeskConflict,
  projectFromScenario,
  removeOffDeskShift,
  resuggestOffDesk,
  saveSchedule,
  savedRows,
  type Project,
} from '../src/app/project'
import { placeOffDesk, suggestOffDesk, type OffDeskLimits } from '../src/core/offDesk'
import { Availability, WEEK_HOURS, slotIndex, type Employee, type Schedule, type ShiftBlock } from '../src/core/types'
import { loadFixture } from './helpers'

const LIMITS: OffDeskLimits = { maxShiftLength: 4, maxDailyHours: 8 }

/** Available (preferred) 9am–5pm Mon–Fri unless `grid` says otherwise. */
function person(id: string, target: number, grid?: (day: number, hour: number) => Availability): Employee {
  const availability = new Uint8Array(WEEK_HOURS)
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      availability[slotIndex(day, hour)] = grid ? grid(day, hour) : day < 5 && hour >= 9 && hour < 17 ? Availability.Preferred : Availability.Unavailable
    }
  }
  return { id, name: id, targetWeeklyHours: target, maxWeeklyHours: 40, availability }
}

const hours = (blocks: ShiftBlock[]) => blocks.reduce((sum, b) => sum + b.endHour - b.startHour, 0)
const overlaps = (a: ShiftBlock, b: ShiftBlock) => a.day === b.day && a.startHour < b.endHour && b.startHour < a.endHour

describe('suggestOffDesk', () => {
  it('gives nothing to people already at target, and nothing beyond anyone’s target', () => {
    const employees = [person('a', 4), person('b', 10)]
    const desk = [[{ day: 0, startHour: 9, endHour: 13 }], [{ day: 1, startHour: 9, endHour: 13 }]]
    const out = suggestOffDesk({ employees, desk, budget: 100, limits: LIMITS })
    expect(hours(out[0])).toBe(0)
    expect(hours(out[1])).toBe(6)
  })

  it('shares a tight budget, narrowing the biggest gaps first', () => {
    const employees = [person('a', 8), person('b', 8), person('c', 12)]
    const out = suggestOffDesk({ employees, desk: [[], [], []], budget: 12, limits: LIMITS })
    // c starts 4h further behind, so takes the first 4h; the other 8h go round in turn.
    expect(out.map(hours)).toEqual([3, 3, 6])
  })

  it('never hands out more than the budget', () => {
    const employees = [person('a', 20), person('b', 20)]
    const out = suggestOffDesk({ employees, desk: [[], []], budget: 7, limits: LIMITS })
    expect(hours(out[0]) + hours(out[1])).toBe(7)
  })

  it('passes hours someone has no room for on to others', () => {
    // a is free only Mon 9–11.
    const a = person('a', 10, (day, hour) => (day === 0 && hour >= 9 && hour < 11 ? Availability.Preferred : Availability.Unavailable))
    const out = suggestOffDesk({ employees: [a, person('b', 10)], desk: [[], []], budget: 8, limits: LIMITS })
    expect(hours(out[0])).toBe(2)
    expect(hours(out[1])).toBe(6)
  })
})

describe('placeOffDesk', () => {
  it('stays inside availability, clear of desk shifts, one block a day, within shift limits', () => {
    const e = person('a', 40)
    const desk = [{ day: 0, startHour: 9, endHour: 12 }, { day: 2, startHour: 13, endHour: 17 }]
    const out = placeOffDesk(e, desk, 30, LIMITS)
    const days = out.map((b) => b.day)
    expect(new Set(days).size).toBe(days.length)
    for (const b of out) {
      expect(b.endHour - b.startHour).toBeLessThanOrEqual(LIMITS.maxShiftLength)
      expect(desk.some((d) => overlaps(d, b))).toBe(false)
      for (let h = b.startHour; h < b.endHour; h++) expect(e.availability[slotIndex(b.day, h)]).not.toBe(Availability.Unavailable)
      // Joined onto a desk shift, the continuous stretch still respects the longest-shift limit.
      for (const d of desk.filter((d) => d.day === b.day && (d.endHour === b.startHour || d.startHour === b.endHour))) {
        expect(Math.max(d.endHour, b.endHour) - Math.min(d.startHour, b.startHour)).toBeLessThanOrEqual(LIMITS.maxShiftLength)
      }
    }
  })

  it('respects the daily limit counting desk hours', () => {
    const e = person('a', 40, (day) => (day === 0 ? Availability.Preferred : Availability.Unavailable))
    const out = placeOffDesk(e, [{ day: 0, startHour: 9, endHour: 15 }], 10, { maxShiftLength: 8, maxDailyHours: 8 })
    expect(hours(out)).toBe(2)
  })

  it('prefers preferred hours over not-preferred ones', () => {
    const e = person('a', 40, (day, hour) => {
      if (day !== 0) return Availability.Unavailable
      if (hour >= 8 && hour < 12) return Availability.NotPreferred
      if (hour >= 14 && hour < 18) return Availability.Preferred
      return Availability.Unavailable
    })
    expect(placeOffDesk(e, [], 3, LIMITS)).toEqual([{ day: 0, startHour: 14, endHour: 17 }])
  })
})

// ---------------------------------------------------------------------------
// On a project's saved schedules.
// ---------------------------------------------------------------------------

const cafe = (budget = 0): Project => ({
  ...projectFromScenario({ ...loadFixture('small-cafe.json'), name: 'Small Cafe' }),
  offDesk: { weeklyBudget: budget },
})

/** ana Mon 9–1, ben Tue 11–3, cleo nothing: everyone below target. */
const schedule = (): Schedule => ({
  patternIndices: new Int32Array(0),
  blocks: [[{ day: 0, startHour: 9, endHour: 13 }], [{ day: 1, startHour: 11, endHour: 15 }], []],
  hoursPerEmployee: [4, 4, 0],
  score: 80,
  penalties: {},
})

describe('off-desk hours on the saved schedule', () => {
  it('suggests hours when a schedule is saved, within budget and targets, clear of desk shifts', () => {
    const p = cafe(6)
    const saved = saveSchedule(p, p, schedule()).saved!
    const total = saved.offDesk.reduce((sum, s) => sum + s.endHour - s.startHour, 0)
    expect(total).toBeGreaterThan(0)
    expect(total).toBeLessThanOrEqual(6)
    for (const row of savedRows(saved)) expect(row.hours).toBeLessThanOrEqual(row.targetWeeklyHours)
    for (const s of saved.offDesk) expect(offDeskConflict({ ...saved, offDesk: [] }, s)).toBeNull()
  })

  it('suggests nothing without a budget', () => {
    const p = cafe(0)
    expect(saveSchedule(p, p, schedule()).saved!.offDesk).toEqual([])
  })

  it('adds, refuses overlaps, removes, clears and re-suggests', () => {
    let p = cafe(0)
    p = saveSchedule(p, p, schedule())
    const add = { employeeId: 'ana', employeeName: 'Ana', day: 1, startHour: 9, endHour: 12 }
    p = addOffDeskShift(p, add)
    expect(p.saved!.offDesk).toEqual([add])

    const clash = { ...add, day: 0, startHour: 12, endHour: 14 }
    expect(offDeskConflict(p.saved!, clash)).toMatch(/desk shift/)
    expect(addOffDeskShift(p, clash)).toBe(p)
    expect(offDeskConflict(p.saved!, { ...add, startHour: 11, endHour: 13 })).toMatch(/off-desk/)

    expect(removeOffDeskShift(p, 'ana', 1, 9).saved!.offDesk).toEqual([])
    expect(clearOffDesk(p).saved!.offDesk).toEqual([])

    p = resuggestOffDesk({ ...p, offDesk: { weeklyBudget: 3 } })
    const total = p.saved!.offDesk.reduce((sum, s) => sum + s.endHour - s.startHour, 0)
    expect(total).toBe(3)
  })

  it('survives a storage round trip, and older saves load with no off-desk hours', () => {
    const p = cafe(6)
    const withSaved = saveSchedule(p, p, schedule())
    const back = normaliseProject(JSON.parse(JSON.stringify(withSaved)))!
    expect(back.offDesk).toEqual({ weeklyBudget: 6 })
    expect(back.saved).toEqual(withSaved.saved)

    const older = JSON.parse(JSON.stringify(withSaved))
    delete older.offDesk
    delete older.saved.offDesk
    const loaded = normaliseProject(older)!
    expect(loaded.offDesk).toEqual({ weeklyBudget: 0 })
    expect(loaded.saved!.offDesk).toEqual([])
  })
})
