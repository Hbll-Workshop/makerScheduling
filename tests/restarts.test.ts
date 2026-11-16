import { describe, expect, it } from 'vitest'
import { buildProblemContext } from '../src/core/patterns'
import { makeRng } from '../src/core/random'
import { TopKSchedules } from '../src/core/report'
import { defaultRules } from '../src/core/rules/builtins'
import { compileRules } from '../src/core/rules/registry'
import { buildSlotOrder, buildValueOrder } from '../src/core/search/ordering'
import { solve, solveWithRestarts, type SearchProgress } from '../src/core/search/solver'
import type { Schedule } from '../src/core/types'
import { loadFixture, meetsCoverage, withinWeeklyHours } from './helpers'

const fake = (indices: number[], score: number): Schedule => ({
  patternIndices: Int32Array.from(indices),
  blocks: [],
  hoursPerEmployee: [],
  score,
  penalties: {},
})

describe('TopKSchedules', () => {
  it('keeps a schedule offered twice only once', () => {
    const pool = new TopKSchedules(3)
    pool.offer(fake([1, 2], 90))
    pool.offer(fake([1, 2], 90))
    pool.offer(fake([2, 1], 80))
    expect(pool.drain().map((s) => s.score)).toEqual([90, 80])
  })

  it('forgets an evicted schedule, so it can be kept again later', () => {
    const pool = new TopKSchedules(1)
    pool.offer(fake([1], 50))
    pool.offer(fake([2], 60))
    pool.offer(fake([1], 70)) // same patterns as the evicted one, rescored only in this test
    expect(pool.drain().map((s) => s.score)).toEqual([70])
  })
})

describe('seeded orderings', () => {
  const { employees, config } = loadFixture('medium-shop.json')
  const ctx = buildProblemContext(employees, config)
  const ruleSet = compileRules(defaultRules(), ctx, -Infinity)

  it('are permutations that differ from the standard order, reproducibly', () => {
    const standard = Array.from(buildSlotOrder(ctx))
    const a = Array.from(buildSlotOrder(ctx, 'day-major', makeRng(1)))
    const b = Array.from(buildSlotOrder(ctx, 'day-major', makeRng(1)))
    expect([...a].sort((x, y) => x - y)).toEqual([...standard].sort((x, y) => x - y))
    expect(a).not.toEqual(standard)
    expect(a).toEqual(b)

    const values = buildValueOrder(ctx, ruleSet, makeRng(2))
    values.forEach((order, slot) => {
      expect(Array.from(order).sort((x, y) => x - y)).toEqual(ctx.patterns[slot].map((_, i) => i))
    })
  })
})

describe('solveWithRestarts', () => {
  it('stops after one pass when the search can finish, matching a single optimising search', () => {
    const { employees, config } = loadFixture('small-cafe.json')
    const shared = { threshold: -Infinity, maxResults: 5, maxNodes: Infinity, maxMillis: 30_000 }
    const single = solve(employees, config, { ...shared, tightenToBest: true })
    const restarted = solveWithRestarts(employees, config, shared)
    expect(restarted.report.complete).toBe(true)
    expect(restarted.report.passes).toBe(1)
    expect(restarted.schedules.map((s) => s.score)).toEqual(single.schedules.map((s) => s.score))
  })

  it('runs several passes on a hard roster, keeping distinct valid schedules best-first', () => {
    const { employees, config } = loadFixture('medium-shop.json')
    const progress: SearchProgress[] = []
    const { schedules, report, ctx } = solveWithRestarts(employees, config, {
      threshold: -Infinity,
      maxResults: 10,
      maxMillis: 3000,
      maxNodes: Infinity,
      onProgress: (p) => progress.push(p),
      progressIntervalMs: 50,
    })
    expect(report.complete).toBe(false)
    expect(report.passes).toBeGreaterThan(1)
    expect(schedules.length).toBe(10)
    expect(new Set(schedules.map((s) => s.patternIndices.join())).size).toBe(schedules.length)
    for (let i = 1; i < schedules.length; i++) expect(schedules[i - 1].score).toBeGreaterThanOrEqual(schedules[i].score)
    for (const s of schedules) {
      expect(meetsCoverage(s.patternIndices, ctx)).toBe(true)
      expect(withinWeeklyHours(s.patternIndices, ctx)).toBe(true)
    }
    // Progress is cumulative across passes: counts never go backwards.
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i].nodesExplored).toBeGreaterThanOrEqual(progress[i - 1].nodesExplored)
      expect(progress[i].pass).toBeGreaterThanOrEqual(progress[i - 1].pass)
    }
    expect(progress.at(-1)!.pass).toBe(report.passes)
  })
})

describe('stopping when the search stalls', () => {
  it('records when the kept set last gained a schedule, ignoring rejects and repeats', async () => {
    const pool = new TopKSchedules(1)
    expect(pool.lastImprovedAt).toBeNull()
    pool.offer(fake([1], 50))
    const first = pool.lastImprovedAt!
    expect(first).toBeGreaterThan(0)
    await new Promise((r) => setTimeout(r, 5))
    pool.offer(fake([2], 40)) // worse: rejected
    pool.offer(fake([1], 50)) // repeat
    expect(pool.lastImprovedAt).toBe(first)
    pool.offer(fake([3], 60))
    expect(pool.lastImprovedAt!).toBeGreaterThan(first)
  })

  it('ends a single search long before its time limit once nothing better turns up', () => {
    const { employees, config } = loadFixture('medium-shop.json')
    const { schedules, report } = solve(employees, config, {
      threshold: -Infinity, tightenToBest: true, maxResults: 10, maxMillis: 30_000, maxNodes: Infinity, stallMillis: 300,
    })
    expect(report.stopReason).toBe('stalled')
    expect(report.complete).toBe(false)
    expect(report.elapsedMs).toBeLessThan(10_000)
    expect(schedules.length).toBe(10)
  })

  it('carries the stall clock across restart passes and stops them all', () => {
    const { employees, config } = loadFixture('medium-shop.json')
    const { report } = solveWithRestarts(employees, config, {
      threshold: -Infinity, maxResults: 10, maxMillis: 30_000, maxNodes: Infinity, stallMillis: 500,
    })
    expect(report.stopReason).toBe('stalled')
    expect(report.elapsedMs).toBeLessThan(15_000)
  })

  it('leaves a search that finishes quickly to finish, and reports it complete', () => {
    const { employees, config } = loadFixture('small-cafe.json')
    const { report } = solveWithRestarts(employees, config, { threshold: -Infinity, maxResults: 5, maxNodes: Infinity, stallMillis: 5000 })
    expect(report.complete).toBe(true)
  })
})
