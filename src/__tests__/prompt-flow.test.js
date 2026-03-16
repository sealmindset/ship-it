// ─── Mock declarations (must be before require) ────────────────────────────

const mockExec = jest.fn();
jest.mock('@actions/exec', () => ({ exec: mockExec }));

const mockLoadConfig = jest.fn();
const mockGenerateShipItYml = jest.fn();
jest.mock('../config-loader', () => ({
  loadConfig: mockLoadConfig,
  generateShipItYml: mockGenerateShipItYml
}));

const mockClassifyIntent = jest.fn();
const mockGetIntentLabel = jest.fn();
jest.mock('../intent', () => ({
  classifyIntent: mockClassifyIntent,
  getIntentLabel: mockGetIntentLabel
}));

const mockScanForBlockers = jest.fn();
jest.mock('../blocker-scan', () => ({ scanForBlockers: mockScanForBlockers }));

const mockCreateOrUpdatePR = jest.fn();
jest.mock('../pr-builder', () => ({ createOrUpdatePR: mockCreateOrUpdatePR }));

const mockEnsureWorkflow = jest.fn();
jest.mock('../workflow-gen', () => ({ ensureWorkflow: mockEnsureWorkflow }));

const mockGenerateGitignore = jest.fn();
const mockGetMissingEntries = jest.fn();
jest.mock('../gitignore-gen', () => ({
  generateGitignore: mockGenerateGitignore,
  getMissingEntries: mockGetMissingEntries
}));

const mockRlQuestion = jest.fn();
const mockRlClose = jest.fn();
jest.mock('readline', () => ({
  createInterface: jest.fn(() => ({
    question: mockRlQuestion,
    close: mockRlClose
  }))
}));

const fs = require('fs');
jest.spyOn(fs, 'existsSync');
jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
jest.spyOn(fs, 'readFileSync').mockReturnValue('');
jest.spyOn(fs, 'appendFileSync').mockImplementation(() => {});

// ─── Helpers ────────────────────────────────────────────────────────────────

const { runInteractiveFlow } = require('../prompt-flow');

/**
 * Build a minimal context/core/octokit fixture.
 */
function makeFixtures(overrides = {}) {
  const inputs = { 'working-directory': '.', arguments: '', ...overrides.inputs };
  const outputs = {};

  return {
    octokit: {
      rest: {
        pulls: {
          create: jest.fn().mockResolvedValue({ data: {} }),
          get: jest.fn().mockResolvedValue({ data: { head: { sha: 'abc123' } } }),
          listReviews: jest.fn().mockResolvedValue({ data: [] })
        },
        repos: {
          getCombinedStatusForRef: jest.fn().mockResolvedValue({ data: { state: 'success' } })
        }
      },
      ...(overrides.octokit || {})
    },
    context: {
      repo: { owner: 'test-owner', repo: 'test-repo' },
      ...(overrides.context || {})
    },
    core: {
      getInput: jest.fn((name) => inputs[name] || ''),
      setOutput: jest.fn((k, v) => { outputs[k] = v; }),
      ...(overrides.core || {})
    },
    outputs
  };
}

/**
 * Configure mockExec to resolve/reject based on the command string.
 * commandMap: { partialMatch: { stdout?, throws? } }
 */
function setupExec(commandMap = {}) {
  mockExec.mockImplementation((_cmd, args, opts) => {
    const command = args?.[1] || '';
    for (const [key, behaviour] of Object.entries(commandMap)) {
      if (command.includes(key)) {
        if (behaviour.throws) return Promise.reject(new Error(behaviour.throws));
        if (behaviour.stdout && opts?.listeners?.stdout) {
          opts.listeners.stdout(Buffer.from(behaviour.stdout));
        }
        return Promise.resolve(0);
      }
    }
    // Default: succeed silently
    if (opts?.listeners?.stdout) {
      opts.listeners.stdout(Buffer.from(''));
    }
    return Promise.resolve(0);
  });
}

/**
 * Set up readline question mock to answer sequentially.
 */
function setupAnswers(answers) {
  let i = 0;
  mockRlQuestion.mockImplementation((_q, cb) => {
    cb(answers[i++] || '');
  });
}

function defaultConfig(overrides = {}) {
  return {
    app: { name: 'test-app', slug: 'test-app', description: 'A test', projectType: 'Web app', stack: 'node', ...overrides.app },
    deployment: { reviewers: ['reviewer1'], ...overrides.deployment },
    context: { hasMakeIt: false, hasShipItYml: false, prodReady: false, detectedStack: 'node', ...overrides.context },
    ...overrides
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  fs.existsSync.mockReturnValue(true);
  mockLoadConfig.mockReturnValue(defaultConfig());
  mockGetMissingEntries.mockReturnValue([]);
  mockGenerateGitignore.mockReturnValue('node_modules/\n');
  mockClassifyIntent.mockReturnValue('experiment');
  mockCreateOrUpdatePR.mockResolvedValue({ url: 'https://github.com/pr/1', number: 1 });
  mockEnsureWorkflow.mockResolvedValue();
});

afterEach(() => {
  console.log.mockRestore();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Preflight: not a git repo
// ═══════════════════════════════════════════════════════════════════════════

describe('preflight: not a git repo', () => {
  it('prints error and returns when .git does not exist', async () => {
    fs.existsSync.mockReturnValue(false);
    setupExec({});

    const { octokit, context, core } = makeFixtures();
    await runInteractiveFlow({ octokit, context, core });

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("don't see a code project")
    );
    // Should not attempt any git commands beyond the .git check
    expect(mockCreateOrUpdatePR).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Preflight: gh not installed
// ═══════════════════════════════════════════════════════════════════════════

describe('preflight: gh not installed', () => {
  it('prints install instructions when gh --version fails', async () => {
    fs.existsSync.mockReturnValue(true);
    setupExec({
      'git branch --show-current': { stdout: 'main' },
      'gh --version': { throws: 'command not found: gh' }
    });

    const { octokit, context, core } = makeFixtures();
    await runInteractiveFlow({ octokit, context, core });

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('GitHub CLI')
    );
    expect(mockCreateOrUpdatePR).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Preflight: gh not authenticated
// ═══════════════════════════════════════════════════════════════════════════

describe('preflight: gh not authenticated', () => {
  it('prints login instructions when gh auth status fails', async () => {
    fs.existsSync.mockReturnValue(true);
    setupExec({
      'git branch --show-current': { stdout: 'main' },
      'gh --version': { stdout: 'gh version 2.40.0' },
      'gh auth status': { throws: 'not logged in' }
    });

    const { octokit, context, core } = makeFixtures();
    await runInteractiveFlow({ octokit, context, core });

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('gh auth login')
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Save mode
// ═══════════════════════════════════════════════════════════════════════════

describe('save mode', () => {
  it('commits, pushes, and creates a draft PR', async () => {
    fs.existsSync.mockReturnValue(true);
    setupExec({
      'git branch --show-current': { stdout: 'main' },
      'gh --version': { stdout: 'gh version 2.40.0' },
      'gh auth status': { stdout: 'Logged in' },
      'git status --porcelain': { stdout: 'M file.js\n' },
      'git log @{u}..HEAD': { stdout: '' },
      'gh pr list': { stdout: '[]' },
      'git log -1 --pretty=%s': { stdout: 'my cool change' }
    });

    const { octokit, context, core, outputs } = makeFixtures({
      inputs: { arguments: 'save' }
    });

    await runInteractiveFlow({ octokit, context, core });

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Saved')
    );
    expect(core.setOutput).toHaveBeenCalledWith('intent', 'save');
    expect(core.setOutput).toHaveBeenCalledWith('deploy-target', 'none');
    // Should have attempted to create a draft PR
    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ draft: true })
    );
  });

  it('skips draft PR creation when an open PR already exists', async () => {
    fs.existsSync.mockReturnValue(true);
    setupExec({
      'git branch --show-current': { stdout: 'feature-branch' },
      'gh --version': { stdout: 'gh version 2.40.0' },
      'gh auth status': { stdout: 'Logged in' },
      'git status --porcelain': { stdout: 'M file.js\n' },
      'git log @{u}..HEAD': { stdout: '' },
      'gh pr list': { stdout: JSON.stringify([{ number: 5, title: 'WIP', url: 'https://github.com/pr/5' }]) }
    });

    const { octokit, context, core } = makeFixtures({
      inputs: { arguments: 'save' }
    });

    await runInteractiveFlow({ octokit, context, core });

    expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Saved')
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Ship mode with make-it context (skips app info questions)
// ═══════════════════════════════════════════════════════════════════════════

describe('ship mode with make-it context', () => {
  it('skips description and reviewer questions', async () => {
    fs.existsSync.mockReturnValue(true);
    mockLoadConfig.mockReturnValue(defaultConfig({
      context: { hasMakeIt: true, hasShipItYml: true, prodReady: false, detectedStack: 'python' }
    }));
    mockClassifyIntent.mockReturnValue('experiment');

    // Answers for the 3 intent questions only (no app info questions)
    setupAnswers(['no', 'no', 'no']);

    setupExec({
      'git branch --show-current': { stdout: 'feature-x' },
      'gh --version': { stdout: 'gh version 2.40.0' },
      'gh auth status': { stdout: 'Logged in' },
      'git status --porcelain': { stdout: 'M file.js\n' },
      'git log @{u}..HEAD': { stdout: '' },
      'gh pr list': { stdout: '[]' }
    });

    const { octokit, context, core } = makeFixtures();
    await runInteractiveFlow({ octokit, context, core });

    // Only 3 questions for intent, NOT 5 (no description/reviewer)
    expect(mockRlQuestion).toHaveBeenCalledTimes(3);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Done')
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Ship mode standalone (asks description and reviewer)
// ═══════════════════════════════════════════════════════════════════════════

describe('ship mode standalone', () => {
  it('asks description and reviewer questions when no make-it context', async () => {
    fs.existsSync.mockReturnValue(true);
    mockLoadConfig.mockReturnValue(defaultConfig({
      context: { hasMakeIt: false, hasShipItYml: false, prodReady: false }
    }));
    mockClassifyIntent.mockReturnValue('shareable');

    // 3 intent questions + 2 app info questions = 5
    setupAnswers(['yes', 'no', 'no', 'My awesome app', 'reviewer-bob']);

    setupExec({
      'git branch --show-current': { stdout: 'feature-y' },
      'gh --version': { stdout: 'gh version 2.40.0' },
      'gh auth status': { stdout: 'Logged in' },
      'git status --porcelain': { stdout: 'M file.js\n' },
      'git log @{u}..HEAD': { stdout: '' },
      'gh pr list': { stdout: '[]' }
    });

    const { octokit, context, core } = makeFixtures();
    await runInteractiveFlow({ octokit, context, core });

    // 3 intent + 2 app info = 5 total questions
    expect(mockRlQuestion).toHaveBeenCalledTimes(5);
    expect(mockCreateOrUpdatePR).toHaveBeenCalledWith(
      expect.objectContaining({
        appInfo: expect.objectContaining({
          description: 'My awesome app',
          reviewer: 'reviewer-bob'
        })
      })
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Re-run mode (open PR detected, with changes)
// ═══════════════════════════════════════════════════════════════════════════

describe('re-run mode', () => {
  it('pushes new changes when an open PR exists and there are changes', async () => {
    fs.existsSync.mockReturnValue(true);
    setupExec({
      'git branch --show-current': { stdout: 'ship-it/my-app' },
      'gh --version': { stdout: 'gh version 2.40.0' },
      'gh auth status': { stdout: 'Logged in' },
      'git status --porcelain': { stdout: 'M file.js\n' },
      'git log @{u}..HEAD': { stdout: '' },
      'gh pr list': { stdout: JSON.stringify([{ number: 10, title: 'Ship my app', url: 'https://github.com/pr/10' }]) }
    });

    const { octokit, context, core } = makeFixtures();
    await runInteractiveFlow({ octokit, context, core });

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Updated')
    );
    expect(core.setOutput).toHaveBeenCalledWith('pr-url', 'https://github.com/pr/10');
    expect(core.setOutput).toHaveBeenCalledWith('pr-number', '10');
    // Should NOT ask any questions
    expect(mockRlQuestion).not.toHaveBeenCalled();
  });

  it('reports PR status when no new changes', async () => {
    fs.existsSync.mockReturnValue(true);
    setupExec({
      'git branch --show-current': { stdout: 'ship-it/my-app' },
      'gh --version': { stdout: 'gh version 2.40.0' },
      'gh auth status': { stdout: 'Logged in' },
      'git status --porcelain': { stdout: '' },
      'git log @{u}..HEAD': { stdout: '' },
      'gh pr list': { stdout: JSON.stringify([{ number: 10, title: 'Ship my app', url: 'https://github.com/pr/10' }]) }
    });

    const { octokit, context, core } = makeFixtures();
    await runInteractiveFlow({ octokit, context, core });

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('already open')
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. No changes to ship
// ═══════════════════════════════════════════════════════════════════════════

describe('no changes to ship', () => {
  it('prints "nothing new" when hasChanges and hasUnpushed are both false', async () => {
    fs.existsSync.mockReturnValue(true);
    setupExec({
      'git branch --show-current': { stdout: 'feature-z' },
      'gh --version': { stdout: 'gh version 2.40.0' },
      'gh auth status': { stdout: 'Logged in' },
      'git status --porcelain': { stdout: '' },
      'git log @{u}..HEAD': { stdout: '' },
      'gh pr list': { stdout: '[]' }
    });

    const { octokit, context, core } = makeFixtures();
    await runInteractiveFlow({ octokit, context, core });

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('nothing new to ship')
    );
    expect(mockCreateOrUpdatePR).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. normalizeAnswer (tested indirectly through intent question answers)
// ═══════════════════════════════════════════════════════════════════════════

describe('normalizeAnswer (indirect)', () => {
  beforeEach(() => {
    fs.existsSync.mockReturnValue(true);
    mockLoadConfig.mockReturnValue(defaultConfig({
      context: { hasMakeIt: true, hasShipItYml: true, prodReady: false }
    }));
    setupExec({
      'git branch --show-current': { stdout: 'feature-norm' },
      'gh --version': { stdout: 'gh version 2.40.0' },
      'gh auth status': { stdout: 'Logged in' },
      'git status --porcelain': { stdout: 'M f.js\n' },
      'git log @{u}..HEAD': { stdout: '' },
      'gh pr list': { stdout: '[]' }
    });
  });

  it('normalizes "yes", "y", "yeah" to true', async () => {
    setupAnswers(['yes', 'y', 'yeah']);
    mockClassifyIntent.mockReturnValue('prod-ready');

    const { octokit, context, core } = makeFixtures();
    await runInteractiveFlow({ octokit, context, core });

    expect(mockClassifyIntent).toHaveBeenCalledWith({
      othersUse: true,
      realData: true,
      impactIfBroken: true
    });
  });

  it('normalizes "no", "n", "nope" to false', async () => {
    setupAnswers(['no', 'n', 'nope']);
    mockClassifyIntent.mockReturnValue('experiment');

    const { octokit, context, core } = makeFixtures();
    await runInteractiveFlow({ octokit, context, core });

    expect(mockClassifyIntent).toHaveBeenCalledWith({
      othersUse: false,
      realData: false,
      impactIfBroken: false
    });
  });

  it('normalizes garbage input to null', async () => {
    setupAnswers(['maybe', 'dunno', 'xyz']);
    mockClassifyIntent.mockReturnValue('experiment');

    const { octokit, context, core } = makeFixtures();
    await runInteractiveFlow({ octokit, context, core });

    expect(mockClassifyIntent).toHaveBeenCalledWith({
      othersUse: null,
      realData: null,
      impactIfBroken: null
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. generateBranchSlug (tested indirectly through branch creation)
// ═══════════════════════════════════════════════════════════════════════════

describe('generateBranchSlug (indirect)', () => {
  it('uses config.app.slug when available for ship mode branch', async () => {
    fs.existsSync.mockReturnValue(true);
    mockLoadConfig.mockReturnValue(defaultConfig({
      app: { slug: 'my-cool-app', name: 'My Cool App', description: 'Cool', projectType: 'Web app', stack: 'node' },
      context: { hasMakeIt: true, hasShipItYml: true, prodReady: true }
    }));

    setupExec({
      'git branch --show-current': { stdout: 'main' },
      'gh --version': { stdout: 'gh version 2.40.0' },
      'gh auth status': { stdout: 'Logged in' },
      'git status --porcelain': { stdout: 'M file.js\n' },
      'git log @{u}..HEAD': { stdout: '' },
      'gh pr list': { stdout: '[]' }
    });

    let createdBranch = null;
    mockExec.mockImplementation((_cmd, args, opts) => {
      const command = args?.[1] || '';
      if (command.includes('git checkout -b')) {
        createdBranch = command.replace('git checkout -b ', '');
      }
      if (command.includes('git branch --show-current') && opts?.listeners?.stdout) {
        opts.listeners.stdout(Buffer.from('main'));
      }
      if (command.includes('gh --version') && opts?.listeners?.stdout) {
        opts.listeners.stdout(Buffer.from('gh version 2.40.0'));
      }
      if (command.includes('gh auth status') && opts?.listeners?.stdout) {
        opts.listeners.stdout(Buffer.from('Logged in'));
      }
      if (command.includes('git status --porcelain') && opts?.listeners?.stdout) {
        opts.listeners.stdout(Buffer.from('M file.js\n'));
      }
      if (command.includes('git log @{u}..HEAD') && opts?.listeners?.stdout) {
        opts.listeners.stdout(Buffer.from(''));
      }
      if (command.includes('gh pr list') && opts?.listeners?.stdout) {
        opts.listeners.stdout(Buffer.from('[]'));
      }
      return Promise.resolve(0);
    });

    const { octokit, context, core } = makeFixtures();
    await runInteractiveFlow({ octokit, context, core });

    expect(createdBranch).toBe('ship-it/my-cool-app');
  });

  it('uses wip/ prefix in save mode when on main', async () => {
    fs.existsSync.mockReturnValue(true);

    let createdBranch = null;
    mockExec.mockImplementation((_cmd, args, opts) => {
      const command = args?.[1] || '';
      if (command.includes('git checkout -b')) {
        createdBranch = command.replace('git checkout -b ', '');
      }
      if (command.includes('git branch --show-current') && opts?.listeners?.stdout) {
        opts.listeners.stdout(Buffer.from('main'));
      }
      if (command.includes('gh --version') && opts?.listeners?.stdout) {
        opts.listeners.stdout(Buffer.from('gh version 2.40.0'));
      }
      if (command.includes('gh auth status') && opts?.listeners?.stdout) {
        opts.listeners.stdout(Buffer.from('Logged in'));
      }
      if (command.includes('git status --porcelain') && opts?.listeners?.stdout) {
        opts.listeners.stdout(Buffer.from('M file.js\n'));
      }
      if (command.includes('git log @{u}..HEAD') && opts?.listeners?.stdout) {
        opts.listeners.stdout(Buffer.from(''));
      }
      if (command.includes('gh pr list') && opts?.listeners?.stdout) {
        opts.listeners.stdout(Buffer.from('[]'));
      }
      if (command.includes('git log -1 --pretty=%s') && opts?.listeners?.stdout) {
        opts.listeners.stdout(Buffer.from(''));
      }
      return Promise.resolve(0);
    });

    const { octokit, context, core } = makeFixtures({
      inputs: { arguments: 'save' }
    });

    await runInteractiveFlow({ octokit, context, core });

    expect(createdBranch).toMatch(/^wip\//);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Additional: prod-ready shortcut skips intent questions
// ═══════════════════════════════════════════════════════════════════════════

describe('prod-ready shortcut', () => {
  it('skips intent questions when config.context.prodReady is true', async () => {
    fs.existsSync.mockReturnValue(true);
    mockLoadConfig.mockReturnValue(defaultConfig({
      context: { hasMakeIt: true, hasShipItYml: true, prodReady: true }
    }));

    setupExec({
      'git branch --show-current': { stdout: 'feature-prod' },
      'gh --version': { stdout: 'gh version 2.40.0' },
      'gh auth status': { stdout: 'Logged in' },
      'git status --porcelain': { stdout: 'M file.js\n' },
      'git log @{u}..HEAD': { stdout: '' },
      'gh pr list': { stdout: '[]' }
    });

    const { octokit, context, core } = makeFixtures();
    await runInteractiveFlow({ octokit, context, core });

    // No questions asked at all (prod-ready + hasMakeIt)
    expect(mockRlQuestion).not.toHaveBeenCalled();
    expect(mockCreateOrUpdatePR).toHaveBeenCalledWith(
      expect.objectContaining({ intent: 'prod-ready' })
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Additional: core outputs are set correctly
// ═══════════════════════════════════════════════════════════════════════════

describe('core outputs', () => {
  it('sets deploy-target to dev+prod for prod-ready intent', async () => {
    fs.existsSync.mockReturnValue(true);
    mockLoadConfig.mockReturnValue(defaultConfig({
      context: { hasMakeIt: true, hasShipItYml: true, prodReady: true }
    }));

    setupExec({
      'git branch --show-current': { stdout: 'feature-out' },
      'gh --version': { stdout: 'gh version 2.40.0' },
      'gh auth status': { stdout: 'Logged in' },
      'git status --porcelain': { stdout: 'M file.js\n' },
      'git log @{u}..HEAD': { stdout: '' },
      'gh pr list': { stdout: '[]' }
    });

    const { octokit, context, core } = makeFixtures();
    await runInteractiveFlow({ octokit, context, core });

    expect(core.setOutput).toHaveBeenCalledWith('intent', 'prod-ready');
    expect(core.setOutput).toHaveBeenCalledWith('deploy-target', 'dev+prod');
    expect(core.setOutput).toHaveBeenCalledWith('pr-url', 'https://github.com/pr/1');
    expect(core.setOutput).toHaveBeenCalledWith('pr-number', '1');
  });

  it('sets deploy-target to dev for shareable intent', async () => {
    fs.existsSync.mockReturnValue(true);
    mockLoadConfig.mockReturnValue(defaultConfig({
      context: { hasMakeIt: true, hasShipItYml: true, prodReady: false }
    }));
    mockClassifyIntent.mockReturnValue('shareable');
    setupAnswers(['yes', 'no', 'no']);

    setupExec({
      'git branch --show-current': { stdout: 'feature-share' },
      'gh --version': { stdout: 'gh version 2.40.0' },
      'gh auth status': { stdout: 'Logged in' },
      'git status --porcelain': { stdout: 'M file.js\n' },
      'git log @{u}..HEAD': { stdout: '' },
      'gh pr list': { stdout: '[]' }
    });

    const { octokit, context, core } = makeFixtures();
    await runInteractiveFlow({ octokit, context, core });

    expect(core.setOutput).toHaveBeenCalledWith('deploy-target', 'dev');
  });

  it('sets deploy-target to none for experiment intent', async () => {
    fs.existsSync.mockReturnValue(true);
    mockLoadConfig.mockReturnValue(defaultConfig({
      context: { hasMakeIt: true, hasShipItYml: true, prodReady: false }
    }));
    mockClassifyIntent.mockReturnValue('experiment');
    setupAnswers(['no', 'no', 'no']);

    setupExec({
      'git branch --show-current': { stdout: 'feature-exp' },
      'gh --version': { stdout: 'gh version 2.40.0' },
      'gh auth status': { stdout: 'Logged in' },
      'git status --porcelain': { stdout: 'M file.js\n' },
      'git log @{u}..HEAD': { stdout: '' },
      'gh pr list': { stdout: '[]' }
    });

    const { octokit, context, core } = makeFixtures();
    await runInteractiveFlow({ octokit, context, core });

    expect(core.setOutput).toHaveBeenCalledWith('deploy-target', 'none');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Additional: readline is always closed
// ═══════════════════════════════════════════════════════════════════════════

describe('cleanup', () => {
  it('closes readline even when an error occurs during ship mode', async () => {
    fs.existsSync.mockReturnValue(true);
    mockLoadConfig.mockReturnValue(defaultConfig({
      context: { hasMakeIt: true, hasShipItYml: true, prodReady: true }
    }));
    mockCreateOrUpdatePR.mockRejectedValue(new Error('PR creation failed'));

    setupExec({
      'git branch --show-current': { stdout: 'feature-err' },
      'gh --version': { stdout: 'gh version 2.40.0' },
      'gh auth status': { stdout: 'Logged in' },
      'git status --porcelain': { stdout: 'M file.js\n' },
      'git log @{u}..HEAD': { stdout: '' },
      'gh pr list': { stdout: '[]' }
    });

    const { octokit, context, core } = makeFixtures();
    await runInteractiveFlow({ octokit, context, core });

    expect(mockRlClose).toHaveBeenCalled();
    // Should print error message
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Something went wrong')
    );
  });
});
