import {
  addDays,
  isIsoDate,
  mondayOf,
  resolveWeek,
  spanIsValid,
  spanSlots,
  spanTiming,
  todayIso,
  weekDayIndex,
  type DatedHours,
  type EmployeeExceptions,
  type IsoDate,
  type TimeSpan,
} from '../core/calendar'
import { ConfigError, DEFAULT_CONFIG, validateProblem } from '../core/config'
import type { Scenario } from '../core/io'
import { suggestOffDesk } from '../core/offDesk'
import { normaliseRuleSettings, type RuleSetting } from '../core/rules/catalog'
import {
  Availability,
  DAY_NAMES,
  DAYS_PER_WEEK,
  HOURS_PER_DAY,
  WEEK_HOURS,
  slotIndex,
  type Employee,
  type OperatingWindow,
  type Schedule,
  type ScheduleConfig,
  type ShiftBlock,
} from '../core/types'

/**
 * The editor's working document.
 *
 * Deliberately plain data — number arrays instead of typed arrays, settings instead of rule
 * objects — so it round-trips through `JSON.stringify` for `localStorage` and through
 * `postMessage` to the solver worker without any custom encoding. {@link projectToProblem}
 * converts it to the solver's types at the boundary.
 */
export interface Project {
  version: 1
  name: string
  /** Monday of the week being scheduled. Dated time off and pins apply only within it. */
  weekStart: IsoDate
  operatingHours: (OperatingWindow | null)[]
  /** 168 entries, `slotIndex(day, hour)`. */
  minCoverage: number[]
  shiftRules: ShiftRules
  employees: ProjectEmployee[]
  rules: RuleSetting[]
  threshold: number
  search: SearchSettings
  /** The schedule chosen for each week, at most one per week, oldest first. */
  saved: SavedSchedule[]
  /**
   * Who is left out of a week's schedule, keyed by that week's Monday. A week with no entry
   * inherits the closest earlier week's, so each week starts as the one before it ended; with no
   * earlier entry at all, everyone works. Storing who is *out* means new hires start in.
   */
  excluded: Record<IsoDate, string[]>
  offDesk: OffDeskSettings
}

/** Off-desk work: paid hours away from the desk, from a budget shared by the whole team. */
export interface OffDeskSettings {
  /** Off-desk hours the whole team may use each week. The same every week. */
  weeklyBudget: number
}

export const DEFAULT_OFF_DESK: OffDeskSettings = { weeklyBudget: 0 }

/**
 * A schedule someone chose to use for a week. Stored as dated shifts with names copied in, so
 * history still reads correctly after the team changes.
 */
export interface SavedSchedule {
  weekStart: IsoDate
  /** ISO timestamp. */
  savedAt: string
  score: number
  /** Everyone on the roster when it was saved, in roster order — including anyone with no shifts. */
  team: SavedMember[]
  shifts: SavedShift[]
  /**
   * Off-desk shifts, which don't count toward coverage. Suggested when the schedule is saved and
   * editable afterwards. Never overlap the same person's desk shifts or each other.
   */
  offDesk: SavedShift[]
}

export interface SavedMember {
  employeeId: string
  employeeName: string
  targetWeeklyHours: number
}

export interface SavedShift {
  employeeId: string
  employeeName: string
  date: IsoDate
  startHour: number
  endHour: number
}

/**
 * How panels change the project: always via a recipe over the latest state. A paint drag fires
 * many events between renders, and a plain `setProject(next)` built from a stale render would
 * silently drop earlier cells of the stroke.
 */
export type ProjectUpdate = (recipe: (project: Project) => Project) => void

export interface ProjectEmployee {
  id: string
  name: string
  maxWeeklyHours: number
  targetWeeklyHours: number
  /** 168 entries of {@link Availability}. The recurring week; time off overrides it. */
  availability: number[]
  timeOff: ProjectTimeOff[]
  /** Painted onto the grid a week at a time; stored as contiguous runs per date. */
  pins: ProjectPin[]
}

/** Ids let the editor list and remove entries. */
export interface ProjectTimeOff extends TimeSpan {
  id: string
}

export interface ProjectPin extends DatedHours {
  id: string
}

export type ShiftRules = Pick<
  ScheduleConfig,
  | 'minShiftLength'
  | 'maxShiftLength'
  | 'maxDailyHours'
  | 'allowSplitShifts'
  | 'minGapBetweenBlocks'
  | 'maxBlocksPerDay'
  | 'maxConsecutiveDays'
>

export interface SearchSettings {
  maxResults: number
  /** Wall-clock budget. The main stop condition in the UI, since node counts mean little to people. */
  timeLimitSeconds: number
  /** `null` means no node limit — JSON cannot store `Infinity`. */
  maxNodes: number | null
  tightenToBest: boolean
  /**
   * Off: keep the best `maxResults` schedules found, whatever they score — no threshold to pick.
   * On: keep schedules scoring at least `threshold` (the original, exhaustive mode).
   */
  useThreshold: boolean
}

export const DEFAULT_SEARCH: SearchSettings = {
  maxResults: 10,
  timeLimitSeconds: 15,
  maxNodes: null,
  tightenToBest: false,
  useThreshold: false,
}

export function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function shiftRulesOf(config: ScheduleConfig): ShiftRules {
  return {
    minShiftLength: config.minShiftLength,
    maxShiftLength: config.maxShiftLength,
    maxDailyHours: config.maxDailyHours,
    allowSplitShifts: config.allowSplitShifts,
    minGapBetweenBlocks: config.minGapBetweenBlocks,
    maxBlocksPerDay: config.maxBlocksPerDay,
    maxConsecutiveDays: config.maxConsecutiveDays,
  }
}

/** A scenario without a week of its own is scheduled for the current week. */
export function projectFromScenario(scenario: Scenario, search = DEFAULT_SEARCH, today = todayIso()): Project {
  return {
    version: 1,
    name: scenario.name,
    weekStart: scenario.weekStart ?? mondayOf(today),
    operatingHours: scenario.config.operatingHours.map((w) => (w ? { ...w } : null)),
    minCoverage: Array.from(scenario.config.minCoverage),
    shiftRules: shiftRulesOf(scenario.config),
    employees: scenario.employees.map((e) => ({
      id: e.id,
      name: e.name,
      maxWeeklyHours: e.maxWeeklyHours,
      targetWeeklyHours: e.targetWeeklyHours,
      availability: Array.from(e.availability),
      timeOff: (scenario.exceptions[e.id]?.timeOff ?? []).map((span) => ({ id: newId(), ...span })),
      pins: (scenario.exceptions[e.id]?.pins ?? []).map((pin) => ({ id: newId(), ...pin })),
    })),
    rules: scenario.rules.map((r) => ({ ...r })),
    threshold: scenario.threshold,
    search: { ...search },
    saved: [],
    excluded: {},
    offDesk: { ...DEFAULT_OFF_DESK },
  }
}

/**
 * What the solver sees: the people working this week, with this week's time off and pins applied.
 * Its employee order is {@link workingEmployees}' order; results are indexed by it.
 */
export function projectToProblem(project: Project): { employees: Employee[]; config: ScheduleConfig } {
  const { employees, config } = projectRoster(project)
  const out = new Set(excludedFor(project, project.weekStart))
  const working = employees.filter((e) => !out.has(e.id))
  return { employees: resolveWeek(working, project.weekStart, projectExceptions(project)), config }
}

// ---------------------------------------------------------------------------
// Who works which week.
// ---------------------------------------------------------------------------

/** Ids left out of `weekStart`: its own entry, else the closest earlier week's, else nobody. */
export function excludedFor(project: Project, weekStart: IsoDate): string[] {
  let best: IsoDate | null = null
  for (const week of Object.keys(project.excluded)) {
    if (week <= weekStart && (best === null || week > best)) best = week
  }
  return best === null ? [] : project.excluded[best]
}

/** The employees scheduled in the project's week, in roster order. */
export function workingEmployees(project: Project): ProjectEmployee[] {
  const out = new Set(excludedFor(project, project.weekStart))
  return project.employees.filter((e) => !out.has(e.id))
}

/** Puts someone in or out of the project's week. Pins that week's list, so later edits elsewhere can't shift it. */
export function setWorking(project: Project, employeeId: string, working: boolean): Project {
  const ids = new Set(project.employees.map((e) => e.id))
  const out = new Set(excludedFor(project, project.weekStart).filter((id) => ids.has(id)))
  if (working) out.delete(employeeId)
  else out.add(employeeId)
  return { ...project, excluded: { ...project.excluded, [project.weekStart]: [...out] } }
}

function projectExceptions(project: Project): Record<string, EmployeeExceptions> {
  return Object.fromEntries(
    project.employees.map((e) => [
      e.id,
      {
        timeOff: e.timeOff.map(({ id: _id, ...span }) => span),
        pins: e.pins.map(({ id: _id, ...pin }) => pin),
      },
    ]),
  )
}

/** The recurring roster, before any dated entries are applied. */
function projectRoster(project: Project): { employees: Employee[]; config: ScheduleConfig } {
  return {
    employees: project.employees.map((e) => ({
      id: e.id,
      name: e.name,
      maxWeeklyHours: e.maxWeeklyHours,
      targetWeeklyHours: e.targetWeeklyHours,
      availability: Uint8Array.from(e.availability),
    })),
    config: {
      ...DEFAULT_CONFIG,
      ...project.shiftRules,
      operatingHours: project.operatingHours.map((w) => (w ? { ...w } : null)),
      minCoverage: Uint8Array.from(project.minCoverage),
    },
  }
}

export function projectToScenario(project: Project): Scenario {
  return {
    name: project.name,
    threshold: project.threshold,
    rules: project.rules,
    weekStart: project.weekStart,
    exceptions: projectExceptions(project),
    ...projectRoster(project),
  }
}

/**
 * The parts of a project that change which schedules are valid or how they score. Results built
 * from a project with a different key are out of date.
 */
export function solveKey(p: Project): string {
  return JSON.stringify([
    p.weekStart, excludedFor(p, p.weekStart), p.operatingHours, p.minCoverage, p.shiftRules, p.employees, p.rules, p.threshold, p.search.useThreshold,
  ])
}

/** Every reason the solver would refuse this project, or an empty list. */
export function projectProblems(project: Project): string[] {
  const { employees, config } = projectToProblem(project)
  try {
    validateProblem(employees, config)
    return []
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
}

export function isOpen(project: Project, day: number, hour: number): boolean {
  const win = project.operatingHours[day]
  return win !== null && hour >= win.startHour && hour < win.endHour
}

/**
 * Hours worth showing in a week grid: from the earliest opening to the latest closing across
 * the week. Rendering all 24 rows would bury a 9-to-5 shop in empty night hours.
 */
export function visibleHours(project: Project): { from: number; to: number } {
  let from = HOURS_PER_DAY
  let to = 0
  for (const win of project.operatingHours) {
    if (!win) continue
    from = Math.min(from, win.startHour)
    to = Math.max(to, win.endHour)
  }
  return from < to ? { from, to } : { from: 8, to: 18 }
}

// ---------------------------------------------------------------------------
// Edits. Each returns a new project; nothing mutates in place, so React state stays honest.
// ---------------------------------------------------------------------------

/**
 * Changes a day's window and clears coverage that would fall outside it. Leaving that coverage
 * in place would make the project unsolvable (the validator rejects coverage demanded while
 * closed) for a reason the admin can no longer see in the grid.
 */
export function setOperatingWindow(project: Project, day: number, win: OperatingWindow | null): Project {
  const operatingHours = project.operatingHours.slice()
  operatingHours[day] = win
  const minCoverage = project.minCoverage.slice()
  for (let hour = 0; hour < HOURS_PER_DAY; hour++) {
    const open = win !== null && hour >= win.startHour && hour < win.endHour
    if (!open) minCoverage[slotIndex(day, hour)] = 0
  }
  return { ...project, operatingHours, minCoverage }
}

/**
 * Opening hours implied by a coverage grid: each day runs from its first hour needing anyone to
 * its last. A day needing nobody is closed. (An hour needing 0 in the middle of a day stays open,
 * just with no minimum: a day has one opening window.)
 */
export function windowsFromCoverage(minCoverage: readonly number[]): (OperatingWindow | null)[] {
  return Array.from({ length: DAYS_PER_WEEK }, (_, day) => {
    let startHour = -1
    let endHour = -1
    for (let hour = 0; hour < HOURS_PER_DAY; hour++) {
      if (minCoverage[slotIndex(day, hour)] > 0) {
        if (startHour < 0) startHour = hour
        endHour = hour + 1
      }
    }
    return startHour < 0 ? null : { startHour, endHour }
  })
}

/** Paints staff needed onto `slots`; opening hours follow the coverage. */
export function paintCoverage(project: Project, slots: Iterable<number>, value: number): Project {
  const minCoverage = paintGrid(project.minCoverage, slots, value)
  return { ...project, minCoverage, operatingHours: windowsFromCoverage(minCoverage) }
}

/** Copies one day's coverage onto other days. */
export function copyDayCoverage(project: Project, from: number, to: readonly number[]): Project {
  const minCoverage = project.minCoverage.slice()
  for (const day of to) {
    for (let hour = 0; hour < HOURS_PER_DAY; hour++) minCoverage[slotIndex(day, hour)] = project.minCoverage[slotIndex(from, hour)]
  }
  return { ...project, minCoverage, operatingHours: windowsFromCoverage(minCoverage) }
}

/** Sets every listed cell of a 168-entry grid to `value`, returning a new grid. */
export function paintGrid(grid: readonly number[], slots: Iterable<number>, value: number): number[] {
  const next = grid.slice()
  for (const slot of slots) next[slot] = value
  return next
}

/** Every slot inside operating hours — the target of "fill all open hours" actions. */
export function openSlots(project: Project): number[] {
  const slots: number[] = []
  for (let day = 0; day < DAYS_PER_WEEK; day++) {
    for (let hour = 0; hour < HOURS_PER_DAY; hour++) {
      if (isOpen(project, day, hour)) slots.push(slotIndex(day, hour))
    }
  }
  return slots
}

/** Open hours someone hasn't marked yet (still unavailable), set to `value`. Hours already marked keep their level. */
export function fillEmptyOpenHours(project: Project, availability: readonly number[], value: number): number[] {
  return paintGrid(availability, openSlots(project).filter((slot) => availability[slot] === Availability.Unavailable), value)
}

export function newEmployee(project: Project): ProjectEmployee {
  const availability = new Array<number>(WEEK_HOURS).fill(Availability.Unavailable)
  for (const slot of openSlots(project)) availability[slot] = Availability.Preferred
  return {
    id: newId(),
    name: `Employee ${project.employees.length + 1}`,
    maxWeeklyHours: 40,
    targetWeeklyHours: 20,
    availability,
    timeOff: [],
    pins: [],
  }
}

export function updateEmployee(project: Project, id: string, patch: Partial<ProjectEmployee>): Project {
  return {
    ...project,
    employees: project.employees.map((e) => (e.id === id ? { ...e, ...patch } : e)),
  }
}

/** Moves the project to the week containing `date`. */
export function setWeekStart(project: Project, date: IsoDate): Project {
  return isIsoDate(date) ? { ...project, weekStart: mondayOf(date) } : project
}

/** Applies `change` to one employee, leaving every other employee object untouched. */
function withEmployee(project: Project, id: string, change: (e: ProjectEmployee) => ProjectEmployee): Project {
  return { ...project, employees: project.employees.map((e) => (e.id === id ? change(e) : e)) }
}

/** Adds time off, ignoring a span that isn't valid. */
export function addTimeOff(project: Project, employeeId: string, span: TimeSpan): Project {
  if (!spanIsValid(span)) return project
  return withEmployee(project, employeeId, (e) => ({
    ...e,
    timeOff: [...e.timeOff, { id: newId(), ...span }].sort(
      (a, b) => a.startDate.localeCompare(b.startDate) || a.startHour - b.startHour,
    ),
  }))
}

export function removeTimeOff(project: Project, employeeId: string, id: string): Project {
  return withEmployee(project, employeeId, (e) => ({ ...e, timeOff: e.timeOff.filter((x) => x.id !== id) }))
}

export function removePin(project: Project, employeeId: string, id: string): Project {
  return withEmployee(project, employeeId, (e) => ({ ...e, pins: e.pins.filter((x) => x.id !== id) }))
}

/**
 * Pins or unpins one hour of the week on screen. The date's pins are rebuilt as contiguous runs,
 * so painting 9, 10 and 11 stores a single 9–12 pin and unpinning 10 splits it in two.
 */
export function setPinnedHour(project: Project, employeeId: string, slot: number, pinned: boolean): Project {
  const date = addDays(project.weekStart, Math.floor(slot / HOURS_PER_DAY))
  const hour = slot % HOURS_PER_DAY
  const employee = project.employees.find((e) => e.id === employeeId)
  if (!employee) return project

  const hours = new Array<boolean>(HOURS_PER_DAY).fill(false)
  for (const pin of employee.pins) {
    if (pin.date === date) for (let h = pin.startHour; h < pin.endHour; h++) hours[h] = true
  }
  if (hours[hour] === pinned) return project
  hours[hour] = pinned

  const runs: ProjectPin[] = []
  let start = -1
  for (let h = 0; h <= HOURS_PER_DAY; h++) {
    const set = h < HOURS_PER_DAY && hours[h]
    if (set && start < 0) start = h
    if (!set && start >= 0) {
      runs.push({ id: newId(), date, startHour: start, endHour: h })
      start = -1
    }
  }
  return withEmployee(project, employeeId, (e) => ({
    ...e,
    pins: [...e.pins.filter((p) => p.date !== date), ...runs].sort(
      (a, b) => a.date.localeCompare(b.date) || a.startHour - b.startHour,
    ),
  }))
}

/** Removes the employee's pins dated in the week on screen; other weeks' pins stay. */
export function clearWeekPins(project: Project, employeeId: string): Project {
  return withEmployee(project, employeeId, (e) => ({
    ...e,
    pins: e.pins.filter((p) => weekDayIndex(project.weekStart, p.date) === null),
  }))
}

/** Column headers for the project's week: `'Mon 21'`. */
export function weekDayLabels(project: Project): string[] {
  return dayLabelsFor(project.weekStart)
}

export function dayLabelsFor(weekStart: IsoDate): string[] {
  return DAY_NAMES.map((name, day) => `${name} ${Number(addDays(weekStart, day).slice(8))}`)
}

/** 168-entry grids marking which hours this week's time off and pins cover for `employee`. */
export function weekMarks(project: Project, employee: ProjectEmployee): { timeOff: boolean[]; pinned: boolean[] } {
  const timeOff = new Array<boolean>(WEEK_HOURS).fill(false)
  for (const span of employee.timeOff) {
    const { from, to } = spanSlots(project.weekStart, span)
    for (let slot = from; slot < to; slot++) timeOff[slot] = true
  }
  const pinned = new Array<boolean>(WEEK_HOURS).fill(false)
  for (const pin of employee.pins) {
    const day = weekDayIndex(project.weekStart, pin.date)
    if (day === null) continue
    for (let hour = pin.startHour; hour < pin.endHour; hour++) pinned[slotIndex(day, hour)] = true
  }
  return { timeOff, pinned }
}

/** Where time off or a pin falls relative to the project's week. */
export function entryTiming(project: Project, entry: TimeSpan | DatedHours): 'past' | 'thisWeek' | 'later' {
  const span: TimeSpan =
    'date' in entry
      ? { startDate: entry.date, startHour: entry.startHour, endDate: entry.date, endHour: entry.endHour }
      : entry
  return spanTiming(project.weekStart, span)
}

// ---------------------------------------------------------------------------
// Saved schedules.
// ---------------------------------------------------------------------------

export function savedScheduleFor(project: Project, weekStart: IsoDate): SavedSchedule | null {
  return project.saved.find((s) => s.weekStart === weekStart) ?? null
}

/**
 * Records `schedule` as the schedule for `solved.weekStart`, replacing any earlier choice for that
 * week. `solved` must be the project the schedule was built from: blocks are indexed by its
 * employee order, which later edits may have changed.
 */
export function saveWeekSchedule(project: Project, solved: Project, schedule: Schedule, now = new Date()): Project {
  const working = workingEmployees(solved)
  const shifts = toSavedShifts(solved.weekStart, working, schedule.blocks)
  const team = working.map((e) => ({ employeeId: e.id, employeeName: e.name, targetWeeklyHours: e.targetWeeklyHours }))
  // Off-desk hours are suggested straight away, from today's budget: changing the budget doesn't
  // make generated schedules stale, so `solved` may predate it.
  const { employees, config } = projectToProblem(solved)
  const offDesk = toSavedShifts(
    solved.weekStart,
    working,
    suggestOffDesk({ employees, desk: schedule.blocks, budget: project.offDesk.weeklyBudget, limits: config }),
  )
  const entry: SavedSchedule = { weekStart: solved.weekStart, savedAt: now.toISOString(), score: schedule.score, team, shifts, offDesk }
  const saved = [...project.saved.filter((s) => s.weekStart !== solved.weekStart), entry]
  saved.sort((a, b) => a.weekStart.localeCompare(b.weekStart))
  return { ...project, saved }
}

/** Blocks per person (in `people` order) as dated shifts, sorted like a saved schedule's. */
function toSavedShifts(weekStart: IsoDate, people: readonly { id: string; name: string }[], blocks: readonly (readonly ShiftBlock[])[]): SavedShift[] {
  const shifts: SavedShift[] = []
  people.forEach((person, i) => {
    for (const block of blocks[i] ?? []) {
      shifts.push({ employeeId: person.id, employeeName: person.name, date: addDays(weekStart, block.day), startHour: block.startHour, endHour: block.endHour })
    }
  })
  return sortShifts(shifts)
}

const sortShifts = (shifts: SavedShift[]) =>
  shifts.sort((a, b) => a.date.localeCompare(b.date) || a.startHour - b.startHour || a.employeeName.localeCompare(b.employeeName))

export function removeSavedSchedule(project: Project, weekStart: IsoDate): Project {
  return { ...project, saved: project.saved.filter((s) => s.weekStart !== weekStart) }
}

export interface SavedRow extends SavedMember {
  shifts: SavedShift[]
  offDesk: SavedShift[]
  deskHours: number
  offDeskHours: number
  /** Desk plus off-desk. */
  hours: number
}

export const shiftHours = (shifts: readonly SavedShift[]) => shifts.reduce((sum, s) => sum + s.endHour - s.startHour, 0)

/** One row per team member of a saved schedule, in roster order, with their shifts and hours. */
export function savedRows(saved: SavedSchedule): SavedRow[] {
  return saved.team.map((member) => {
    const shifts = saved.shifts.filter((s) => s.employeeId === member.employeeId)
    const offDesk = saved.offDesk.filter((s) => s.employeeId === member.employeeId)
    const deskHours = shiftHours(shifts)
    const offDeskHours = shiftHours(offDesk)
    return { ...member, shifts, offDesk, deskHours, offDeskHours, hours: deskHours + offDeskHours }
  })
}

// ---------------------------------------------------------------------------
// Off-desk hours on a saved schedule.
// ---------------------------------------------------------------------------

function withSaved(project: Project, weekStart: IsoDate, change: (s: SavedSchedule) => SavedSchedule): Project {
  return { ...project, saved: project.saved.map((s) => (s.weekStart === weekStart ? change(s) : s)) }
}

/**
 * Fresh off-desk suggestions for a saved week, replacing whatever it had. Uses the roster as it is
 * now (availability, time off, targets), for team members who are still on it.
 */
export function resuggestOffDesk(project: Project, weekStart: IsoDate): Project {
  const saved = savedScheduleFor(project, weekStart)
  if (!saved) return project
  const atWeek = { ...project, weekStart }
  const { employees: resolved, config } = projectToProblem({ ...atWeek, excluded: {} })
  const byId = new Map(resolved.map((e) => [e.id, e]))
  const members = saved.team.filter((m) => byId.has(m.employeeId))
  const employees = members.map((m) => byId.get(m.employeeId)!)
  const desk = members.map((m) => blocksOf(weekStart, saved.shifts.filter((s) => s.employeeId === m.employeeId)))
  const blocks = suggestOffDesk({ employees, desk, budget: project.offDesk.weeklyBudget, limits: config })
  const people = members.map((m) => ({ id: m.employeeId, name: m.employeeName }))
  return withSaved(project, weekStart, (s) => ({ ...s, offDesk: toSavedShifts(weekStart, people, blocks) }))
}

function blocksOf(weekStart: IsoDate, shifts: readonly SavedShift[]): ShiftBlock[] {
  return shifts.flatMap((s) => {
    const day = weekDayIndex(weekStart, s.date)
    return day === null ? [] : [{ day, startHour: s.startHour, endHour: s.endHour }]
  })
}

export function clearOffDesk(project: Project, weekStart: IsoDate): Project {
  return withSaved(project, weekStart, (s) => ({ ...s, offDesk: [] }))
}

/** Why an off-desk shift can't be added to a saved week, or `null` if it can. */
export function offDeskConflict(saved: SavedSchedule, shift: Omit<SavedShift, 'employeeName'>): string | null {
  if (weekDayIndex(saved.weekStart, shift.date) === null) return 'That date is outside this week.'
  if (!(shift.startHour >= 0 && shift.startHour < shift.endHour && shift.endHour <= HOURS_PER_DAY)) return 'The end must be after the start.'
  const overlaps = (s: SavedShift) =>
    s.employeeId === shift.employeeId && s.date === shift.date && s.startHour < shift.endHour && shift.startHour < s.endHour
  if (saved.shifts.some(overlaps)) return 'That overlaps one of their desk shifts.'
  if (saved.offDesk.some(overlaps)) return 'That overlaps another of their off-desk shifts.'
  return null
}

/** Adds an off-desk shift to a saved week; ignored if {@link offDeskConflict} finds a problem. */
export function addOffDeskShift(project: Project, weekStart: IsoDate, shift: SavedShift): Project {
  const saved = savedScheduleFor(project, weekStart)
  if (!saved || offDeskConflict(saved, shift) !== null) return project
  return withSaved(project, weekStart, (s) => ({ ...s, offDesk: sortShifts([...s.offDesk, { ...shift }]) }))
}

/** Removes the off-desk shift starting at `startHour` on `date` for that person. */
export function removeOffDeskShift(project: Project, weekStart: IsoDate, employeeId: string, date: IsoDate, startHour: number): Project {
  return withSaved(project, weekStart, (s) => ({
    ...s,
    offDesk: s.offDesk.filter((x) => !(x.employeeId === employeeId && x.date === date && x.startHour === startHour)),
  }))
}

// ---------------------------------------------------------------------------
// Persistence.
// ---------------------------------------------------------------------------

export const STORAGE_KEY = 'scheduleMaker.project.v1'

const isDatedHours = (value: unknown): value is DatedHours => {
  const v = value as Partial<DatedHours> | null
  return (
    typeof v === 'object' && v !== null && isIsoDate(v.date) &&
    Number.isInteger(v.startHour) && Number.isInteger(v.endHour) &&
    v.startHour! >= 0 && v.startHour! < v.endHour! && v.endHour! <= HOURS_PER_DAY
  )
}

const entryId = (raw: unknown) => {
  const id = (raw as { id?: unknown }).id
  return typeof id === 'string' ? id : newId()
}

/** Pins from storage, or `null` if any is malformed. A missing list is an older save: empty. */
function normalisePins(raw: unknown): ProjectPin[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || !raw.every(isDatedHours)) return null
  return raw.map((pin) => ({ id: entryId(pin), date: pin.date, startHour: pin.startHour, endHour: pin.endHour }))
}

/**
 * Time off from storage, or `null` if any entry is malformed. Early saves stored single-day
 * `{ date, startHour, endHour }` entries; those become one-day spans.
 */
function normaliseTimeOff(raw: unknown): ProjectTimeOff[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return null
  const out: ProjectTimeOff[] = []
  for (const entry of raw) {
    if (isDatedHours(entry)) {
      out.push({ id: entryId(entry), startDate: entry.date, startHour: entry.startHour, endDate: entry.date, endHour: entry.endHour })
      continue
    }
    const span = entry as Partial<TimeSpan> | null
    if (typeof span !== 'object' || span === null) return null
    const candidate = { startDate: span.startDate, startHour: span.startHour, endDate: span.endDate, endHour: span.endHour } as TimeSpan
    if (!spanIsValid(candidate)) return null
    out.push({ id: entryId(entry), ...candidate })
  }
  return out
}

const isSavedShift = (value: unknown): value is SavedShift => {
  const v = value as Partial<SavedShift> | null
  return (
    typeof v === 'object' && v !== null && typeof v.employeeId === 'string' && typeof v.employeeName === 'string' &&
    isDatedHours({ date: v.date, startHour: v.startHour, endHour: v.endHour })
  )
}

const isSavedMember = (value: unknown): value is SavedMember => {
  const v = value as Partial<SavedMember> | null
  return typeof v === 'object' && v !== null && typeof v.employeeId === 'string' && typeof v.employeeName === 'string' && Number.isFinite(v.targetWeeklyHours)
}

const copyShift = ({ employeeId, employeeName, date, startHour, endHour }: SavedShift): SavedShift => ({ employeeId, employeeName, date, startHour, endHour })

/** Saved schedules from storage, or `null` if any is malformed. A missing list is an older save: empty. */
function normaliseSaved(raw: unknown): SavedSchedule[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return null
  const out: SavedSchedule[] = []
  for (const entry of raw) {
    const s = entry as Partial<SavedSchedule> | null
    if (typeof s !== 'object' || s === null) return null
    if (!isIsoDate(s.weekStart) || mondayOf(s.weekStart) !== s.weekStart) return null
    if (typeof s.savedAt !== 'string' || !Number.isFinite(s.score)) return null
    if (!Array.isArray(s.shifts) || !s.shifts.every(isSavedShift)) return null
    if (!Array.isArray(s.team) || !s.team.every(isSavedMember)) return null
    const offDesk = s.offDesk ?? []
    if (!Array.isArray(offDesk) || !offDesk.every(isSavedShift)) return null
    out.push({
      weekStart: s.weekStart,
      savedAt: s.savedAt,
      score: s.score!,
      team: s.team.map(({ employeeId, employeeName, targetWeeklyHours }) => ({ employeeId, employeeName, targetWeeklyHours })),
      shifts: s.shifts.map(copyShift),
      offDesk: offDesk.map(copyShift),
    })
  }
  return out.sort((a, b) => a.weekStart.localeCompare(b.weekStart))
}

/** Who sat out which week, or `null` if malformed. A missing record is an older save: nobody. */
function normaliseExcluded(raw: unknown): Record<IsoDate, string[]> | null {
  if (raw === undefined) return {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const out: Record<IsoDate, string[]> = {}
  for (const [week, ids] of Object.entries(raw)) {
    if (!isIsoDate(week) || mondayOf(week) !== week) return null
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return null
    out[week] = [...ids]
  }
  return out
}

const isGrid = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length === WEEK_HOURS && value.every((v) => Number.isInteger(v) && v >= 0)

/**
 * Accepts anything that came out of storage or a file and returns a well-formed project, or
 * `null`. Structural problems reject the whole document; merely-missing optional sections
 * (rules, search settings) fall back to defaults so older saves keep loading.
 */
export function normaliseProject(raw: unknown, today = todayIso()): Project | null {
  if (typeof raw !== 'object' || raw === null) return null
  const p = raw as Partial<Project>
  if (p.version !== 1 || typeof p.name !== 'string') return null
  if (!Array.isArray(p.operatingHours) || p.operatingHours.length !== DAYS_PER_WEEK) return null
  if (!isGrid(p.minCoverage) || !Array.isArray(p.employees) || typeof p.shiftRules !== 'object') return null
  if (p.weekStart !== undefined && (!isIsoDate(p.weekStart) || mondayOf(p.weekStart) !== p.weekStart)) return null

  const employees: ProjectEmployee[] = []
  for (const e of p.employees) {
    if (typeof e?.id !== 'string' || typeof e.name !== 'string' || !isGrid(e.availability)) return null
    const timeOff = normaliseTimeOff(e.timeOff)
    const pins = normalisePins(e.pins)
    if (!timeOff || !pins) return null
    employees.push({ ...e, timeOff, pins })
  }
  const saved = normaliseSaved(p.saved)
  if (!saved) return null
  const excluded = normaliseExcluded(p.excluded)
  if (!excluded) return null
  return {
    version: 1,
    name: p.name,
    weekStart: p.weekStart ?? mondayOf(today),
    // Opening hours follow coverage now; older saves could hold hours that needed nobody.
    operatingHours: windowsFromCoverage(p.minCoverage),
    minCoverage: p.minCoverage,
    shiftRules: { ...shiftRulesOf(DEFAULT_CONFIG), ...p.shiftRules },
    employees,
    rules: normaliseRuleSettings(p.rules),
    threshold: Number.isFinite(p.threshold) ? p.threshold! : 0,
    search: { ...DEFAULT_SEARCH, ...p.search },
    saved,
    excluded,
    offDesk: normaliseOffDesk(p.offDesk),
  }
}

/** Off-desk settings from storage; missing or nonsense values fall back to no budget. */
function normaliseOffDesk(raw: unknown): OffDeskSettings {
  const budget = (raw as Partial<OffDeskSettings> | null)?.weeklyBudget
  return { weeklyBudget: Number.isInteger(budget) && budget! >= 0 ? budget! : DEFAULT_OFF_DESK.weeklyBudget }
}

/** Storage can be missing or throw (private windows, blocked site data) — treat that as empty. */
export function loadProject(storage: Pick<Storage, 'getItem'> | undefined): Project | null {
  try {
    const text = storage?.getItem(STORAGE_KEY)
    return text ? normaliseProject(JSON.parse(text)) : null
  } catch {
    return null
  }
}

export function saveProject(storage: Pick<Storage, 'setItem'> | undefined, project: Project): boolean {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(project))
    return storage !== undefined
  } catch {
    return false
  }
}
