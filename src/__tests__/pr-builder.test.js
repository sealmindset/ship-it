const { createOrUpdatePR } = require('../pr-builder');

// --- Mock octokit factory ---

function makeMockOctokit({ existingPRs = [] } = {}) {
  return {
    rest: {
      pulls: {
        list: jest.fn().mockResolvedValue({ data: existingPRs }),
        create: jest.fn().mockResolvedValue({ data: { html_url: 'https://github.com/test/pr/1', number: 1 } }),
        update: jest.fn().mockResolvedValue({ data: { html_url: 'https://github.com/test/pr/1', number: 1 } }),
        requestReviewers: jest.fn().mockResolvedValue({})
      },
      issues: {
        createLabel: jest.fn().mockResolvedValue({}),
        addLabels: jest.fn().mockResolvedValue({})
      }
    }
  };
}

// --- Shared defaults ---

const baseArgs = {
  owner: 'testowner',
  repo: 'testrepo',
  branch: 'ship-it/deploy',
  baseBranch: 'main',
  intent: 'experiment',
  appInfo: { description: 'Test app', othersUse: false, realData: false },
  config: {
    app: {
      name: '',
      slug: '',
      description: '',
      stack: '',
      services: [],
      auth: { provider: 'none' },
      database: { engine: 'none' }
    },
    context: { hasMakeIt: false },
    infra: { configured: false },
    deployment: {}
  }
};

function callPR(overrides = {}, octokitOpts) {
  const octokit = makeMockOctokit(octokitOpts);
  const args = { ...baseArgs, ...overrides, octokit };
  // Deep-merge config if provided
  if (overrides.config) {
    args.config = {
      ...baseArgs.config,
      ...overrides.config,
      app: { ...baseArgs.config.app, ...(overrides.config.app || {}) },
      infra: { ...baseArgs.config.infra, ...(overrides.config.infra || {}) },
      deployment: { ...baseArgs.config.deployment, ...(overrides.config.deployment || {}) },
      context: { ...baseArgs.config.context, ...(overrides.config.context || {}) }
    };
  }
  return { octokit, promise: createOrUpdatePR(args) };
}

// ============================================================
// Tests
// ============================================================

describe('createOrUpdatePR', () => {

  // 1. New PR creation
  describe('new PR creation', () => {
    test('creates PR with correct owner, repo, head, base', async () => {
      const { octokit, promise } = callPR();
      const result = await promise;

      expect(octokit.rest.pulls.create).toHaveBeenCalledTimes(1);
      expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'testowner',
          repo: 'testrepo',
          head: 'ship-it/deploy',
          base: 'main'
        })
      );
      expect(result.isNew).toBe(true);
      expect(result.url).toBe('https://github.com/test/pr/1');
      expect(result.number).toBe(1);
    });

    test('adds intent label and ship-it-managed label', async () => {
      const { octokit, promise } = callPR({ intent: 'shareable' });
      await promise;

      expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: ['intent:shareable', 'ship-it-managed']
        })
      );
    });

    test('ensures all label colors are created', async () => {
      const { octokit, promise } = callPR();
      await promise;

      // 4 labels: 3 intent labels + ship-it-managed
      expect(octokit.rest.issues.createLabel).toHaveBeenCalledTimes(4);
    });

    test('ignores 422 (label already exists) from createLabel', async () => {
      const octokit = makeMockOctokit();
      octokit.rest.issues.createLabel.mockRejectedValue({ status: 422 });

      const result = await createOrUpdatePR({ ...baseArgs, octokit });
      expect(result.url).toBeDefined();
    });
  });

  // 2. PR update when open PR exists
  describe('PR update', () => {
    test('updates existing PR instead of creating', async () => {
      const existingPR = { number: 42, html_url: 'https://github.com/test/pr/42' };
      const { octokit, promise } = callPR({}, { existingPRs: [existingPR] });
      // Override the update mock to return the existing PR data
      octokit.rest.pulls.update.mockResolvedValue({ data: existingPR });

      const result = await promise;

      expect(octokit.rest.pulls.update).toHaveBeenCalledTimes(1);
      expect(octokit.rest.pulls.update).toHaveBeenCalledWith(
        expect.objectContaining({ pull_number: 42 })
      );
      expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
      expect(result.isNew).toBe(false);
    });
  });

  // 3. Title format
  describe('title format', () => {
    test('includes intent prefix in brackets', async () => {
      const { octokit, promise } = callPR({ intent: 'prod-ready' });
      await promise;

      const title = octokit.rest.pulls.create.mock.calls[0][0].title;
      expect(title).toMatch(/^\[prod-ready\]/);
    });

    test('uses config app name and description when present', async () => {
      const { octokit, promise } = callPR({
        intent: 'experiment',
        config: { app: { name: 'My App', description: 'A cool tool' } }
      });
      await promise;

      const title = octokit.rest.pulls.create.mock.calls[0][0].title;
      expect(title).toBe('[experiment] My App: A cool tool');
    });

    test('falls back to app name as description when description is empty', async () => {
      const { octokit, promise } = callPR({
        intent: 'shareable',
        config: { app: { name: 'Widget', description: '' } }
      });
      await promise;

      const title = octokit.rest.pulls.create.mock.calls[0][0].title;
      expect(title).toBe('[shareable] Widget: Widget');
    });

    test('falls back to appInfo description when no config app name', async () => {
      const { octokit, promise } = callPR({
        intent: 'experiment',
        appInfo: { description: 'Quick prototype' }
      });
      await promise;

      const title = octokit.rest.pulls.create.mock.calls[0][0].title;
      expect(title).toBe('[experiment] Quick prototype');
    });

    test('truncates long descriptions', async () => {
      const longDesc = 'A'.repeat(100);
      const { octokit, promise } = callPR({
        intent: 'experiment',
        appInfo: { description: longDesc }
      });
      await promise;

      const title = octokit.rest.pulls.create.mock.calls[0][0].title;
      // [experiment] + truncated to 60 chars
      expect(title.length).toBeLessThanOrEqual('[experiment] '.length + 60);
      expect(title).toContain('...');
    });
  });

  // 4. Body sections
  describe('body sections', () => {
    test('contains all required sections', async () => {
      const { octokit, promise } = callPR({ intent: 'experiment' });
      await promise;

      const body = octokit.rest.pulls.create.mock.calls[0][0].body;
      expect(body).toContain('## What this does');
      expect(body).toContain("## Who's affected");
      expect(body).toContain('## Data involved');
      expect(body).toContain('## Risk if something goes wrong');
      expect(body).toContain('## Infrastructure status');
      expect(body).toContain('*Managed by /ship-it*');
    });

    test('shows "Just me" for experiment intent', async () => {
      const { octokit, promise } = callPR({ intent: 'experiment' });
      await promise;

      const body = octokit.rest.pulls.create.mock.calls[0][0].body;
      expect(body).toContain('Just me (developer only)');
    });

    test('shows "Team members" for shareable when othersUse is true', async () => {
      const { octokit, promise } = callPR({
        intent: 'shareable',
        appInfo: { othersUse: true }
      });
      await promise;

      const body = octokit.rest.pulls.create.mock.calls[0][0].body;
      expect(body).toContain('Team members / demo audience');
    });

    test('shows "End users" for prod-ready intent', async () => {
      const { octokit, promise } = callPR({ intent: 'prod-ready' });
      await promise;

      const body = octokit.rest.pulls.create.mock.calls[0][0].body;
      expect(body).toContain('End users / production systems');
    });

    test('shows "Test/synthetic data only" when realData is falsy', async () => {
      const { octokit, promise } = callPR({ appInfo: { realData: false } });
      await promise;

      const body = octokit.rest.pulls.create.mock.calls[0][0].body;
      expect(body).toContain('Test/synthetic data only');
    });

    test('shows "Real data" when realData is true', async () => {
      const { octokit, promise } = callPR({ appInfo: { realData: true } });
      await promise;

      const body = octokit.rest.pulls.create.mock.calls[0][0].body;
      expect(body).toContain('Real data');
    });

    test('shows low risk for experiment', async () => {
      const { octokit, promise } = callPR({ intent: 'experiment' });
      await promise;

      const body = octokit.rest.pulls.create.mock.calls[0][0].body;
      expect(body).toContain('Low -- only affects me');
    });

    test('shows high risk for prod-ready', async () => {
      const { octokit, promise } = callPR({ intent: 'prod-ready' });
      await promise;

      const body = octokit.rest.pulls.create.mock.calls[0][0].body;
      expect(body).toContain('High -- business/customer impact');
    });
  });

  // 5. App details from make-it
  describe('app details from make-it', () => {
    test('includes app details when hasMakeIt is true', async () => {
      const { octokit, promise } = callPR({
        config: {
          context: { hasMakeIt: true },
          app: {
            name: 'TestApp',
            stack: 'FastAPI + Next.js',
            services: [{ name: 'backend', port: 8000 }, { name: 'frontend', port: 3000 }],
            auth: { provider: 'Azure AD' },
            database: { engine: 'PostgreSQL', version: '16' }
          }
        }
      });
      await promise;

      const body = octokit.rest.pulls.create.mock.calls[0][0].body;
      expect(body).toContain('## App details');
      expect(body).toContain('**Stack:** FastAPI + Next.js');
      expect(body).toContain('backend (:8000)');
      expect(body).toContain('frontend (:3000)');
      expect(body).toContain('**Auth:** Azure AD');
      expect(body).toContain('**Database:** PostgreSQL 16');
    });

    test('omits app details section when no make-it context and no stack', async () => {
      const { octokit, promise } = callPR({
        config: {
          context: { hasMakeIt: false },
          app: { stack: '' }
        }
      });
      await promise;

      const body = octokit.rest.pulls.create.mock.calls[0][0].body;
      expect(body).not.toContain('## App details');
    });

    test('omits auth line when provider is none', async () => {
      const { octokit, promise } = callPR({
        config: {
          context: { hasMakeIt: true },
          app: {
            stack: 'FastAPI',
            services: [],
            auth: { provider: 'none' },
            database: { engine: 'none' }
          }
        }
      });
      await promise;

      const body = octokit.rest.pulls.create.mock.calls[0][0].body;
      expect(body).toContain('## App details');
      expect(body).not.toContain('**Auth:**');
      expect(body).not.toContain('**Database:**');
    });
  });

  // 6. Infra configured
  describe('infrastructure configured', () => {
    test('shows configured with AWS details', async () => {
      const { octokit, promise } = callPR({
        config: {
          app: { slug: 'myapp' },
          infra: {
            configured: true,
            provider: 'aws',
            aws: { region: 'us-west-2', ecs: { cluster_name: 'prod-cluster' }, dns: { domain: 'example.com' } }
          }
        }
      });
      await promise;

      const body = octokit.rest.pulls.create.mock.calls[0][0].body;
      expect(body).toContain('DevOps infrastructure configured');
      expect(body).toContain('**Provider:** AWS (us-west-2)');
      expect(body).toContain('**Cluster:** prod-cluster');
      expect(body).toContain('**URL:** myapp.example.com');
    });

    test('shows configured with Azure details', async () => {
      const { octokit, promise } = callPR({
        config: {
          app: { slug: 'myapp' },
          infra: {
            configured: true,
            provider: 'azure',
            azure: { aks: { cluster_name: 'aks-prod' }, dns: { zone_name: 'azure.example.com' } }
          }
        }
      });
      await promise;

      const body = octokit.rest.pulls.create.mock.calls[0][0].body;
      expect(body).toContain('**Provider:** Azure');
      expect(body).toContain('**Cluster:** aks-prod');
      expect(body).toContain('**URL:** myapp.azure.example.com');
    });
  });

  // 7. Infra not configured
  describe('infrastructure not configured', () => {
    test('shows pending message with DevOps guide link', async () => {
      const { octokit, promise } = callPR({
        config: { infra: { configured: false } }
      });
      await promise;

      const body = octokit.rest.pulls.create.mock.calls[0][0].body;
      expect(body).toContain('Pending DevOps infrastructure configuration');
      expect(body).toContain('DevOps onboarding guide');
      expect(body).toContain('.ship-it.yml');
    });
  });

  // 8. Smart checklist (prod-ready only)
  describe('smart checklist', () => {
    test('prod-ready intent includes "Before going live" checklist', async () => {
      const { octokit, promise } = callPR({ intent: 'prod-ready' });
      await promise;

      const body = octokit.rest.pulls.create.mock.calls[0][0].body;
      expect(body).toContain('## Before going live');
      expect(body).toContain('Your DevOps team will set up anything you check');
    });

    test('experiment intent does not include checklist', async () => {
      const { octokit, promise } = callPR({ intent: 'experiment' });
      await promise;

      const body = octokit.rest.pulls.create.mock.calls[0][0].body;
      expect(body).not.toContain('## Before going live');
    });

    test('auth is pre-checked when provider is configured', async () => {
      const { octokit, promise } = callPR({
        intent: 'prod-ready',
        config: {
          app: { auth: { provider: 'Azure AD' }, database: { engine: 'none' }, services: [] }
        }
      });
      await promise;

      const body = octokit.rest.pulls.create.mock.calls[0][0].body;
      expect(body).toContain('[x] **User login (SSO)** -- already set up with Azure AD');
    });

    test('auth is unchecked when provider is none', async () => {
      const { octokit, promise } = callPR({
        intent: 'prod-ready',
        config: {
          app: { auth: { provider: 'none' }, database: { engine: 'none' }, services: [] }
        }
      });
      await promise;

      const body = octokit.rest.pulls.create.mock.calls[0][0].body;
      expect(body).toContain('[ ] **User login (SSO)**');
    });

    test('includes database checklist item when engine is configured', async () => {
      const { octokit, promise } = callPR({
        intent: 'prod-ready',
        config: {
          app: { auth: { provider: 'none' }, database: { engine: 'PostgreSQL' }, services: [] }
        }
      });
      await promise;

      const body = octokit.rest.pulls.create.mock.calls[0][0].body;
      expect(body).toContain('**Database** -- production PostgreSQL instance needed');
    });

    test('DNS is pre-checked when AWS infra has dns domain', async () => {
      const { octokit, promise } = callPR({
        intent: 'prod-ready',
        config: {
          app: { slug: 'myapp', auth: { provider: 'none' }, database: { engine: 'none' }, services: [] },
          infra: { configured: true, provider: 'aws', aws: { dns: { domain: 'example.com' } } }
        }
      });
      await promise;

      const body = octokit.rest.pulls.create.mock.calls[0][0].body;
      expect(body).toContain('[x] **DNS setup** -- myapp.example.com');
    });

    test('includes DevOps infra checklist item when infra not configured', async () => {
      const { octokit, promise } = callPR({
        intent: 'prod-ready',
        config: {
          app: { auth: { provider: 'none' }, database: { engine: 'none' }, services: [] },
          infra: { configured: false }
        }
      });
      await promise;

      const body = octokit.rest.pulls.create.mock.calls[0][0].body;
      expect(body).toContain('[ ] **DevOps infrastructure**');
    });
  });

  // 9. Custom prerequisites
  describe('custom prerequisites', () => {
    test('uses deployment.prerequisites instead of smart checklist', async () => {
      const { octokit, promise } = callPR({
        intent: 'prod-ready',
        config: {
          deployment: {
            prerequisites: ['Get VP approval', 'Schedule downtime window']
          }
        }
      });
      await promise;

      const body = octokit.rest.pulls.create.mock.calls[0][0].body;
      expect(body).toContain('- [ ] Get VP approval');
      expect(body).toContain('- [ ] Schedule downtime window');
      // Smart checklist items should NOT appear
      expect(body).not.toContain('**User login (SSO)**');
      expect(body).not.toContain('**SSL');
    });
  });

  // 10. Reviewers from config
  describe('reviewers from config', () => {
    test('requests reviewers from deployment.reviewers', async () => {
      const { octokit, promise } = callPR({
        config: {
          deployment: { reviewers: ['alice', 'bob'] }
        }
      });
      await promise;

      expect(octokit.rest.pulls.requestReviewers).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewers: ['alice', 'bob']
        })
      );
    });
  });

  // 11. Reviewers from appInfo
  describe('reviewers from appInfo', () => {
    test('falls back to appInfo.reviewer when no config reviewers', async () => {
      const { octokit, promise } = callPR({
        appInfo: { reviewer: 'charlie' },
        config: { deployment: {} }
      });
      await promise;

      expect(octokit.rest.pulls.requestReviewers).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewers: ['charlie']
        })
      );
    });

    test('config reviewers take priority over appInfo.reviewer', async () => {
      const { octokit, promise } = callPR({
        appInfo: { reviewer: 'charlie' },
        config: { deployment: { reviewers: ['alice'] } }
      });
      await promise;

      expect(octokit.rest.pulls.requestReviewers).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewers: ['alice']
        })
      );
    });
  });

  // 12. No reviewers
  describe('no reviewers', () => {
    test('does not call requestReviewers when none configured', async () => {
      const { octokit, promise } = callPR({
        appInfo: {},
        config: { deployment: {} }
      });
      await promise;

      expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
    });

    test('does not call requestReviewers when reviewer is TBD', async () => {
      const { octokit, promise } = callPR({
        appInfo: { reviewer: 'TBD' },
        config: { deployment: {} }
      });
      await promise;

      expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
    });
  });
});
