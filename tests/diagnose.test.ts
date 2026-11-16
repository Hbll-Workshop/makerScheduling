import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/core/config'
import { diagnoseInfeasible } from '../src/core/diagnose'
import { solve } from '../src/core/search/solver'
import { Availability, WEEK_HOURS, slotIndex, type Employee, type ScheduleConfig } from '../src/core/types'

/** Available on the given days for `[from, to)`, unavailable otherwise. */
function person(id: string, maxWeeklyHours: number, spans: [day: number, from: number, to: number][]): Employee {
  const availability = new Uint8Array(WEEK_HOURS)
  for (const [day, from, to] of spans) for (let h = from; h < to; h++) availability[slotIndex(day, h)] = Availability.Preferred
  return { id, name: id, maxWeeklyHours, targetWeeklyHours: 0, availability }
}

/** Open only on the listed days, needing `need[day][hour]`-style headcount over `[from, to)`. */
function config(rules: Partial<ScheduleConfig>, demand: [day: number, from: number, to: number, need: number][], windows: [day: number, from: number, to: number][]): ScheduleConfig {
  const operatingHours: ScheduleConfig['operatingHours'] = Array.from({ length: 7 }, () => null)
  for (const [day, from, to] of windows) operatingHours[day] = { startHour: from, endHour: to }
  const minCoverage = new Uint8Array(WEEK_HOURS)
  for (const [day, from, to, n] of demand) for (let h = from; h < to; h++) minCoverage[slotIndex(day, h)] = n
  return { ...DEFAULT_CONFIG, allowSplitShifts: false, maxBlocksPerDay: 1, ...rules, operatingHours, minCoverage }
}

/** Confirms the scenario really is impossible, so each test checks the explanation, not the setup. */
function expectImpossible(employees: Employee[], cfg: ScheduleConfig) {
  const { schedules, report } = solve(employees, cfg, { rules: [], threshold: -Infinity, maxResults: 1, maxMillis: 10_000 })
  expect(report.complete).toBe(true)
  expect(schedules).toEqual([])
}

describe('diagnoseInfeasible', () => {
  it('names an hour nobody can reach with a long-enough shift, and why', () => {
    const employees = [person('Ana', 40, [[0, 9, 11]])]
    const cfg = config({ minShiftLength: 3 }, [[0, 9, 11, 1]], [[0, 9, 12]])
    expectImpossible(employees, cfg)
    const [message] = diagnoseInfeasible(employees, cfg)
    expect(message).toContain('Mon 9am–11am needs 1 person, but nobody can work a legal shift then')
    expect(message).toContain('Ana is available but is only free 9am–11am there (2h), shorter than the shortest shift (3h)')
  })

  it('names a day that needs more staff-hours than the daily limit allows', () => {
    const employees = [person('Ana', 40, [[0, 9, 17]]), person('Ben', 40, [[0, 9, 17]])]
    const cfg = config({ minShiftLength: 3, maxShiftLength: 6, maxDailyHours: 6 }, [[0, 9, 17, 2]], [[0, 9, 17]])
    expectImpossible(employees, cfg)
    expect(diagnoseInfeasible(employees, cfg)).toEqual([expect.stringContaining('Mon needs 16 staff-hours, but the people who can work that day can cover at most 12')])
  })

  it('names a week that needs more staff-hours than weekly maximums allow', () => {
    const employees = [person('Ana', 8, [[0, 9, 15], [1, 9, 15]])]
    const cfg = config({ minShiftLength: 3, maxShiftLength: 8, maxDailyHours: 8 }, [[0, 9, 15, 1], [1, 9, 15, 1]], [[0, 9, 15], [1, 9, 15]])
    expectImpossible(employees, cfg)
    const [message] = diagnoseInfeasible(employees, cfg)
    expect(message).toContain('The week needs 12 staff-hours, but everyone working can cover at most 8')
    expect(message).toContain('Ana 8h (max 8h a week)')
  })

  it('narrows a day whose shifts can’t be fitted together to the impossible stretch', () => {
    // Ana is the only one who can cover 9am and 1–3pm, but one 3h shift can't reach both.
    const employees = [person('Ana', 40, [[0, 9, 15]]), person('Ben', 40, [[0, 10, 13]])]
    const cfg = config({ minShiftLength: 3, maxShiftLength: 3, maxDailyHours: 3 }, [[0, 9, 15, 1]], [[0, 9, 15]])
    expectImpossible(employees, cfg)
    const [message] = diagnoseInfeasible(employees, cfg)
    expect(message).toContain("Mon 9am–2pm can't be covered: it needs 1 person every hour")
    expect(message).toContain('Available then: Ana (9am–2pm); Ben (10am–1pm)')
  })

  it('says when every day works alone but weekly hours run out across them', () => {
    // Only Ana can do Tue and Wed, and her weekly maximum fits one of them. Cleo pads Monday's
    // capacity so the weekly total alone doesn't give it away.
    const employees = [
      person('Ana', 3, [[1, 9, 12], [2, 9, 12]]),
      person('Ben', 3, [[0, 9, 12]]),
      person('Cleo', 40, [[0, 9, 12]]),
    ]
    const cfg = config({ minShiftLength: 3, maxShiftLength: 3, maxDailyHours: 3 }, [[0, 9, 12, 1], [1, 9, 12, 1], [2, 9, 12, 1]], [[0, 9, 12], [1, 9, 12], [2, 9, 12]])
    expectImpossible(employees, cfg)
    expect(diagnoseInfeasible(employees, cfg)).toEqual([expect.stringContaining("Each day can be staffed on its own, but not all in the same week")])
  })
})
