const { scanForBlockers } = require('../blocker-scan');

const basePR = {
  number: 1,
  base: { ref: 'main' },
  head: { ref: 'feature' },
  mergeable: true
};

function createMockOctokit(overrides = {}) {
  return {
    rest: {
      pulls: {
        list: jest.fn().mockResolvedValue({ data: [] })
      },
      issues: {
        listEventsForTimeline: jest.fn().mockResolvedValue({ data: [] })
      },
      repos: {
        getCombinedStatusForRef: jest.fn().mockResolvedValue({ data: { statuses: [] } }),
        getContent: jest.fn().mockResolvedValue({ data: [] })
      },
      ...overrides
    }
  };
}

describe('scanForBlockers', () => {
  test('no blockers - all checks pass', async () => {
    const octokit = createMockOctokit();
    const result = await scanForBlockers({
      octokit, owner: 'o', repo: 'r', pr: basePR, branch: 'feature'
    });

    expect(result.hard).toEqual([]);
    expect(result.soft).toEqual([]);
    expect(result.hasHardBlockers).toBe(false);
    expect(result.summary).toBe('No blockers found. You are clear to ship.');
  });

  test('merge conflicts - pr.mergeable === false produces hard blocker', async () => {
    const octokit = createMockOctokit();
    const pr = { ...basePR, mergeable: false };
    const result = await scanForBlockers({
      octokit, owner: 'o', repo: 'r', pr, branch: 'feature'
    });

    expect(result.hard).toHaveLength(1);
    expect(result.hard[0]).toMatch(/conflicts/i);
    expect(result.hasHardBlockers).toBe(true);
  });

  test('other open PRs - soft blocker about other changes', async () => {
    const octokit = createMockOctokit();
    octokit.rest.pulls.list.mockResolvedValue({
      data: [
        { number: 1 },
        { number: 2 },
        { number: 3 }
      ]
    });

    const result = await scanForBlockers({
      octokit, owner: 'o', repo: 'r', pr: basePR, branch: 'feature'
    });

    expect(result.soft).toHaveLength(1);
    expect(result.soft[0]).toMatch(/2 other open change/);
    expect(result.hasHardBlockers).toBe(false);
  });

  test('failing status checks - soft blocker with check names', async () => {
    const octokit = createMockOctokit();
    octokit.rest.repos.getCombinedStatusForRef.mockResolvedValue({
      data: {
        statuses: [
          { state: 'success', context: 'ci/build' },
          { state: 'failure', context: 'ci/lint' },
          { state: 'error', context: 'ci/test' }
        ]
      }
    });

    const result = await scanForBlockers({
      octokit, owner: 'o', repo: 'r', pr: basePR, branch: 'feature'
    });

    expect(result.soft).toHaveLength(1);
    expect(result.soft[0]).toMatch(/ci\/lint/);
    expect(result.soft[0]).toMatch(/ci\/test/);
    expect(result.hasHardBlockers).toBe(false);
  });

  test('linked open issues - soft blocker about open issues', async () => {
    const octokit = createMockOctokit();
    octokit.rest.issues.listEventsForTimeline.mockResolvedValue({
      data: [
        { event: 'cross-referenced', source: { issue: { state: 'open' } } },
        { event: 'cross-referenced', source: { issue: { state: 'closed' } } },
        { event: 'labeled' }
      ]
    });

    const result = await scanForBlockers({
      octokit, owner: 'o', repo: 'r', pr: basePR, branch: 'feature'
    });

    expect(result.soft).toHaveLength(1);
    expect(result.soft[0]).toMatch(/1 open issue/);
    expect(result.hasHardBlockers).toBe(false);
  });

  test('no workflow directory - 404 produces soft blocker about no automation', async () => {
    const octokit = createMockOctokit();
    const error404 = new Error('Not Found');
    error404.status = 404;
    octokit.rest.repos.getContent.mockRejectedValue(error404);

    const result = await scanForBlockers({
      octokit, owner: 'o', repo: 'r', pr: basePR, branch: 'feature'
    });

    expect(result.soft).toHaveLength(1);
    expect(result.soft[0]).toMatch(/automation/i);
    expect(result.hasHardBlockers).toBe(false);
  });

  test('multiple blockers - hard and soft combined in summary', async () => {
    const octokit = createMockOctokit();
    // Merge conflict (hard)
    const pr = { ...basePR, mergeable: false };
    // Other open PRs (soft)
    octokit.rest.pulls.list.mockResolvedValue({
      data: [{ number: 1 }, { number: 5 }]
    });
    // Failing checks (soft)
    octokit.rest.repos.getCombinedStatusForRef.mockResolvedValue({
      data: { statuses: [{ state: 'failure', context: 'ci/test' }] }
    });

    const result = await scanForBlockers({
      octokit, owner: 'o', repo: 'r', pr, branch: 'feature'
    });

    expect(result.hard).toHaveLength(1);
    expect(result.soft).toHaveLength(2);
    expect(result.hasHardBlockers).toBe(true);
    expect(result.summary).toContain('conflicts');
    expect(result.summary).toContain('other open change');
    expect(result.summary).toContain('ci/test');
  });

  test('API errors are non-critical - pulls.list throws without crashing', async () => {
    const octokit = createMockOctokit();
    octokit.rest.pulls.list.mockRejectedValue(new Error('API rate limit'));

    const result = await scanForBlockers({
      octokit, owner: 'o', repo: 'r', pr: basePR, branch: 'feature'
    });

    // Should not throw; the pull check is silently skipped
    expect(result.hard).toEqual([]);
    expect(result.summary).toBe('No blockers found. You are clear to ship.');
  });
});
