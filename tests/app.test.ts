import { describe, expect, it } from 'vitest'
import {
  loadProject,
  normaliseProject,
  projectFromScenario,
  projectProblems,
  projectToProblem,
  projectToScenario,
  saveProject,
  setOperatingWindow,
  STORAGE_KEY,
} from '../src/app/project'
import { parseScenario, serializeScenario, type Scenario, type ScenarioJson } from '../src/core/io'
import { defaultRules } from '../src/core/rules/builtins'
import { buildRules, defaultRuleSettings, normaliseRuleSettings } from '../src/core/rules/catalog'
import { solve } from '../src/core/search/solver'
import { slotIndex } from '../src/core/types'
import { handleRequest } from '../src/worker/handler'
import type { SolveResponse } from '../src/worker/protocol'
import { loadFixture } from './helpers'

/** Typed arrays don't deep-equal plain arrays, so compare scenarios in a neutral form. */
const plain = (s: Scenario) =>
  JSON.parse(
    JSON.stringify(s, (_key, value) => (ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value)),
  )

describe('scenario serialization', () => {
  for (const fixture of ['small-cafe.json', 'medium-shop.json']) {
    it(`${fixture}: parse(serialize(s)) reproduces s exactly`, () => {
      const scenario = parseScenario(JSON.parse(JSON.stringify(serializeScenario(loadFixtureScenario(fixture)))))
      expect(plain(scenario)).toEqual(plain(loadFixtureScenario(fixture)))
    })
  }

  it('opens an older scenario file, ignoring its week and dated time off and pins', () => {
    const json = serializeScenario(loadFixtureScenario('small-cafe.json')) as ScenarioJson & Record<string, unknown>
    const older = {
      ...json,
      weekStart: '2026-09-21',
      employees: json.employees.map((e) => ({ ...e, timeOff: [{ date: '2026-09-22' }], pins: [{ date: '2026-09-21', hours: [9, 11] }] })),
    }
    expect(plain(parseScenario(older as ScenarioJson))).toEqual(plain(loadFixtureScenario('small-cafe.json')))
  })

  it('preserves per-hour coverage changes, including adjacent different headcounts', () => {
    const scenario = loadFixtureScenario('small-cafe.json')
    scenario.config.minCoverage[slotIndex(0, 10)] = 3
    scenario.config.minCoverage[slotIndex(0, 11)] = 2
    const again = parseScenario(serializeScenario(scenario))
    expect(Array.from(again.config.minCoverage)).toEqual(Array.from(scenario.config.minCoverage))
  })
})

function loadFixtureScenario(name: string): Scenario {
  return { ...loadFixture(name), name }
}

describe('rule catalog', () => {
  it('default settings build the same rules as defaultRules()', () => {
    const fromSettings = buildRules(defaultRuleSettings()).map((r) => [r.id, r.weight])
    const builtin = defaultRules().map((r) => [r.id, r.weight])
    expect(fromSettings).toEqual(builtin)
  })

  it('leaves disabled rules out entirely', () => {
    const settings = defaultRuleSettings().map((s) => (s.id === 'clopen' ? { ...s, enabled: false } : s))
    expect(buildRules(settings).map((r) => r.id)).not.toContain('clopen')
  })

  it('fills in missing rules, drops unknown ids, and clamps negative weights', () => {
    const settings = normaliseRuleSettings([
      { id: 'splitShift', weight: 9, enabled: false },
      { id: 'clopen', weight: -4 },
      { id: 'notARule' as never, weight: 1 },
    ])
    expect(settings.map((s) => s.id)).toEqual(defaultRuleSettings().map((s) => s.id))
    expect(settings.find((s) => s.id === 'splitShift')).toMatchObject({ weight: 9, enabled: false })
    expect(settings.find((s) => s.id === 'clopen')!.weight).toBe(0)
  })

  it('solving with catalog rules matches solving with the builtins', () => {
    const { employees, config } = loadFixture('small-cafe.json')
    const shared = { threshold: 70, maxResults: 1_000_000, maxNodes: Infinity, maxMillis: Infinity }
    const viaCatalog = solve(employees, config, { ...shared, rules: buildRules(defaultRuleSettings()) })
    const viaBuiltins = solve(employees, config, { ...shared, rules: defaultRules() })
    const keys = (r: typeof viaCatalog) => r.schedules.map((s) => `${s.patternIndices.join(',')}@${s.score}`)
    expect(keys(viaCatalog)).toEqual(keys(viaBuiltins))
  })
})

describe('project model', () => {
  const scenario = () => loadFixtureScenario('medium-shop.json')

  it('round-trips a scenario through the editor model', () => {
    expect(plain(projectToScenario(projectFromScenario(scenario())))).toEqual(plain(scenario()))
  })

  it('survives JSON storage unchanged', () => {
    const project = projectFromScenario(scenario())
    expect(normaliseProject(JSON.parse(JSON.stringify(project)))).toEqual(project)
  })

  it('rejects structurally broken documents', () => {
    const project = projectFromScenario(scenario())
    expect(normaliseProject(null)).toBeNull()
    expect(normaliseProject({ ...project, version: 2 })).toBeNull()
    expect(normaliseProject({ ...project, minCoverage: [1, 2, 3] })).toBeNull()
    expect(normaliseProject({ ...project, employees: [{ ...project.employees[0], availability: [] }] })).toBeNull()
  })

  it('fills optional sections an older save might lack', () => {
    const { rules: _rules, search: _search, offDesk: _offDesk, ...older } = projectFromScenario(scenario())
    older.employees = older.employees.map(({ working: _w, ...e }) => e as never)
    const loaded = normaliseProject(older)
    expect(loaded?.rules).toEqual(defaultRuleSettings())
    expect(loaded?.search.timeLimitSeconds).toBeGreaterThan(0)
    expect(loaded?.offDesk.weeklyBudget).toBe(0)
    expect(loaded?.employees.every((e) => e.working)).toBe(true)
    expect(loaded?.saved).toBeNull()
  })

  it('migrates a save from when schedules were kept per dated week', () => {
    const project = JSON.parse(JSON.stringify(projectFromScenario(loadFixtureScenario('small-cafe.json'))))
    const shift = (date: string, startHour: number, endHour: number) => ({ employeeId: 'ana', employeeName: 'Ana', date, startHour, endHour })
    const team = [{ employeeId: 'ana', employeeName: 'Ana', targetWeeklyHours: 8 }]
    const older = {
      ...project,
      weekStart: '2026-09-28',
      // Ben sat out from the 21st on; Cleo only the week before.
      excluded: { '2026-09-14': ['cleo'], '2026-09-21': ['ben'] },
      saved: [
        { weekStart: '2026-09-28', savedAt: '2026-09-27T10:00:00Z', score: 90, team, shifts: [shift('2026-09-30', 9, 13)], offDesk: [shift('2026-10-01', 9, 11)] },
        { weekStart: '2026-09-21', savedAt: '2026-09-20T10:00:00Z', score: 70, team, shifts: [shift('2026-09-21', 9, 13)] },
      ],
      employees: project.employees.map(({ working: _w, ...e }: Record<string, unknown>) => ({
        ...e,
        timeOff: [{ id: 't', startDate: '2026-09-22', startHour: 0, endDate: '2026-09-22', endHour: 24 }],
        pins: [{ id: 'p', date: '2026-09-21', startHour: 9, endHour: 11 }],
      })),
    }
    const loaded = normaliseProject(older)!
    expect(loaded.employees.map((e) => [e.id, e.working])).toEqual([['ana', true], ['ben', false], ['cleo', true]])
    expect(loaded.employees.every((e) => !('timeOff' in e) && !('pins' in e))).toBe(true)
    // The most recent week becomes the schedule, its dates turned into weekdays (Wed, Thu).
    expect(loaded.saved?.score).toBe(90)
    expect(loaded.saved?.shifts).toEqual([{ employeeId: 'ana', employeeName: 'Ana', day: 2, startHour: 9, endHour: 13 }])
    expect(loaded.saved?.offDesk).toEqual([{ employeeId: 'ana', employeeName: 'Ana', day: 3, startHour: 9, endHour: 11 }])
    expect('weekStart' in loaded).toBe(false)
  })

  it('closing or narrowing a day clears coverage outside the new window', () => {
    const project = projectFromScenario(scenario())
    const narrowed = setOperatingWindow(project, 0, { startHour: 12, endHour: 16 })
    expect(narrowed.minCoverage[slotIndex(0, 8)]).toBe(0)
    expect(narrowed.minCoverage[slotIndex(0, 12)]).toBe(project.minCoverage[slotIndex(0, 12)])
    expect(narrowed.minCoverage[slotIndex(0, 16)]).toBe(0)
    expect(projectProblems(narrowed).some((p) => p.includes('outside operating hours'))).toBe(false)

    const closed = setOperatingWindow(project, 1, null)
    for (let hour = 0; hour < 24; hour++) expect(closed.minCoverage[slotIndex(1, hour)]).toBe(0)
  })

  it('surfaces validation problems without throwing', () => {
    const project = projectFromScenario(scenario())
    expect(projectProblems(project)).toEqual([])
    expect(projectProblems({ ...project, employees: [] })).toContain('no employees provided')
  })

  it('treats unavailable or failing storage as empty rather than crashing', () => {
    const throwing = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('quota') },
    }
    expect(loadProject(throwing)).toBeNull()
    expect(loadProject(undefined)).toBeNull()
    expect(saveProject(throwing, projectFromScenario(scenario()))).toBe(false)
    expect(saveProject(undefined, projectFromScenario(scenario()))).toBe(false)
  })

  it('saves and loads through storage', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    const project = projectFromScenario(scenario())
    expect(saveProject(storage, project)).toBe(true)
    expect(store.has(STORAGE_KEY)).toBe(true)
    expect(loadProject(storage)).toEqual(project)
  })
})

describe('solver progress', () => {
  it('reports progress that ends at the final totals', () => {
    const { employees, config } = loadFixture('medium-shop.json')
    const seen: number[] = []
    const { report } = solve(employees, config, {
      threshold: -200,
      maxNodes: 40_000,
      progressIntervalMs: 0,
      onProgress: (p) => seen.push(p.nodesExplored),
    })
    expect(seen.length).toBeGreaterThan(1)
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)
    expect(seen[seen.length - 1]).toBe(report.nodesExplored)
  })
})

/**
 * The worker handler is the whole solver as the UI sees it. Every message must survive
 * structured cloning, or `postMessage` fails at runtime in the browser — a failure no
 * typecheck would catch.
 */
describe('worker handler', () => {
  const run = (type: 'solve' | 'calibrate', project = projectFromScenario(loadFixtureScenario('small-cafe.json'))) => {
    const messages: SolveResponse[] = []
    handleRequest({ type, runId: 7, project }, (m) => messages.push(structuredClone(m)))
    return messages
  }

  it('answers a solve with exactly one terminal message matching a direct solve', () => {
    const project = projectFromScenario(loadFixtureScenario('small-cafe.json'))
    project.threshold = 70
    project.search = { ...project.search, maxResults: 1000, timeLimitSeconds: 60, useThreshold: true }
    const messages = run('solve', project)

    const terminal = messages.filter((m) => m.type !== 'progress')
    expect(terminal).toHaveLength(1)
    expect(terminal[0].runId).toBe(7)
    expect(terminal[0].type).toBe('solved')

    const { employees, config } = projectToProblem(project)
    const direct = solve(employees, config, { threshold: 70, maxResults: 1000, maxMillis: 60_000, maxNodes: Infinity })
    if (terminal[0].type !== 'solved') throw new Error('unreachable')
    expect(terminal[0].report.complete).toBe(true)
    expect(terminal[0].schedules.map((s) => s.score)).toEqual(direct.schedules.map((s) => s.score))
  })

  it('answers a calibration', () => {
    const terminal = run('calibrate').filter((m) => m.type !== 'progress')
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toMatchObject({ type: 'calibrated', runId: 7, bestScore: 80 })
  })

  it('turns an invalid project into an error message with the problem list', () => {
    const project = { ...projectFromScenario(loadFixtureScenario('small-cafe.json')), employees: [] }
    const [message] = run('solve', project)
    expect(message.type).toBe('error')
    if (message.type !== 'error') throw new Error('unreachable')
    expect(message.problems).toContain('no employees provided')
  })
})
