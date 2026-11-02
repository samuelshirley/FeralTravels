import { describe, expect, it } from 'vitest';
import {
  compareFeatureRequests,
  optimisticVote,
  votingOpen,
  type FeatureRequestView,
} from './featureRequests';

const row = (p: Partial<FeatureRequestView>): FeatureRequestView => ({
  id: 'x',
  title: 'x',
  body: null,
  status: 'open',
  reply: null,
  voteCount: 0,
  votedByMe: false,
  createdAt: '2026-11-01T00:00:00.000Z',
  ...p,
});

describe('compareFeatureRequests', () => {
  it('in progress, then open by votes, then not doing; newer first on a tie', () => {
    const list = [
      row({ title: 'closed, many votes', status: 'not_doing', voteCount: 50 }),
      row({ title: 'open 2', voteCount: 2 }),
      row({ title: 'open 9', voteCount: 9 }),
      row({ title: 'in progress, no votes', status: 'in_progress' }),
      row({ title: 'open 2, newer', voteCount: 2, createdAt: '2026-11-02T00:00:00.000Z' }),
    ];
    expect(list.sort(compareFeatureRequests).map((r) => r.title)).toEqual([
      'in progress, no votes',
      'open 9',
      'open 2, newer',
      'open 2',
      'closed, many votes',
    ]);
  });
});

describe('votingOpen', () => {
  it('only not_doing closes voting', () => {
    expect(votingOpen('open')).toBe(true);
    expect(votingOpen('in_progress')).toBe(true);
    expect(votingOpen('not_doing')).toBe(false);
  });
});

describe('optimisticVote', () => {
  it('adds and removes one, and a repeat changes nothing', () => {
    expect(optimisticVote({ voteCount: 3, votedByMe: false }, true)).toEqual({ voteCount: 4, votedByMe: true });
    expect(optimisticVote({ voteCount: 4, votedByMe: true }, false)).toEqual({ voteCount: 3, votedByMe: false });
    expect(optimisticVote({ voteCount: 4, votedByMe: true }, true)).toEqual({ voteCount: 4, votedByMe: true });
  });

  it('never goes below zero', () => {
    expect(optimisticVote({ voteCount: 0, votedByMe: true }, false)).toEqual({ voteCount: 0, votedByMe: false });
  });
});
