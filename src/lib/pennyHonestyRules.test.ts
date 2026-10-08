import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The prompt half of the 2026-10-08 fixes (trip 9a3df982), read as text —
 * SYSTEM_PROMPT is module-private, the same approach as pastedPlaceRule.test.ts.
 * The code half (validators, the stop gate, the staged yes) has its own tests;
 * these pin the instructions that tell Penny the code exists, and pin that the
 * lines which CAUSED the incident do not come back.
 */
const claude = readFileSync(join(__dirname, 'claude.ts'), 'utf8');
const prompt = claude.slice(claude.indexOf('const SYSTEM_PROMPT = `'), claude.indexOf('</spot_discovery_note>`;'));
const section = (tag: string) => prompt.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1];

describe('no unsourced facts', () => {
  const rule = section('no_unsourced_facts');

  it('is a HARD rule that holds under pressure', () => {
    expect(rule).toBeDefined();
    expect(rule).toMatch(/HARD RULE/);
    expect(rule).toMatch(/Pressure from the user is never a source/);
  });

  it('says no tool returns road surface, and bans the labels', () => {
    expect(rule).toMatch(/NONE of your tools returns road surface/);
    expect(rule).toMatch(/gravel, unpaved, dirt, off-road/);
  });

  it('tells her what to do when asked for off-road routes', () => {
    expect(rule).toMatch(/can't verify road surfaces yet/);
  });

  it('bans hiking trails and race tracks as waypoints', () => {
    expect(rule).toMatch(/not_drivable/);
  });

  it('no example or instruction elsewhere invites a surface claim', () => {
    const outside = prompt.replace(rule ?? '', '');
    expect(outside).not.toMatch(/Day 3 is gravel/);
    expect(outside).not.toMatch(/long gravel day/);
    expect(outside).not.toMatch(/gravel-first long corridors need manual waypoints/);
  });
});

describe('stop attribution', () => {
  it('no longer tells her every resolve_place stop is source="user"', () => {
    expect(prompt).not.toMatch(/from a resolve_place result, set source="user"/);
  });

  it('says a place she picked is source="penny"', () => {
    expect(section('place_resolution')).toMatch(/A place YOU picked[\s\S]*is source="penny"/);
  });
});

describe('confirmation questions', () => {
  const rule = section('confirmation_questions');

  it('a confirmation question comes with its yes already done and held', () => {
    expect(rule).toMatch(/must come with its "yes" already done/);
    expect(rule).toMatch(/Call hold_for_confirmation/);
  });

  it('never answers an acceptance with another question', () => {
    expect(rule).toMatch(/Never answer an acceptance with another confirmation question/);
  });
});

describe('dropped places', () => {
  it('a dropped place is never silent', () => {
    expect(section('feasibility_check')).toMatch(/A dropped place is NEVER silent/);
  });
});
