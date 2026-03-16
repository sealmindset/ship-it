const path = require('path');
const fs = require('fs');
const { loadConfig, generateShipItYml } = require('../config-loader');

// Use a temp directory for test fixtures
const FIXTURES = path.join(__dirname, '__fixtures__');

beforeAll(() => {
  fs.mkdirSync(FIXTURES, { recursive: true });
});

afterAll(() => {
  fs.rmSync(FIXTURES, { recursive: true, force: true });
});

afterEach(() => {
  // Clean up fixture files after each test
  const files = ['.ship-it.yml', '.make-it-state.md', 'package.json',
    'requirements.txt', 'next.config.js', 'docker-compose.yml'];
  for (const file of files) {
    try { fs.unlinkSync(path.join(FIXTURES, file)); } catch {}
  }
  try { fs.rmSync(path.join(FIXTURES, '.make-it'), { recursive: true, force: true }); } catch {}
});

describe('loadConfig', () => {
  test('returns defaults when no config files exist', () => {
    const config = loadConfig({ workingDir: FIXTURES });

    expect(config.app.name).toBe('');
    expect(config.app.slug).toBe('');
    expect(config.infra.configured).toBe(false);
    expect(config.context.hasMakeIt).toBe(false);
    expect(config.context.hasShipItYml).toBe(false);
  });

  test('detects Node.js stack from package.json', () => {
    fs.writeFileSync(path.join(FIXTURES, 'package.json'), '{}');

    const config = loadConfig({ workingDir: FIXTURES });
    expect(config.app.stack).toBe('nodejs');
    expect(config.context.detectedStack).toBe('nodejs');
  });

  test('detects Next.js stack from package.json + next.config.js', () => {
    fs.writeFileSync(path.join(FIXTURES, 'package.json'), '{}');
    fs.writeFileSync(path.join(FIXTURES, 'next.config.js'), 'module.exports = {}');

    const config = loadConfig({ workingDir: FIXTURES });
    expect(config.app.stack).toBe('nextjs');
  });

  test('detects fastapi-nextjs stack from package.json + next.config + requirements.txt', () => {
    fs.writeFileSync(path.join(FIXTURES, 'package.json'), '{}');
    fs.writeFileSync(path.join(FIXTURES, 'next.config.js'), 'module.exports = {}');
    fs.writeFileSync(path.join(FIXTURES, 'requirements.txt'), 'fastapi');

    const config = loadConfig({ workingDir: FIXTURES });
    expect(config.app.stack).toBe('fastapi-nextjs');
  });

  test('loads app-context.json from .make-it directory', () => {
    const makeItDir = path.join(FIXTURES, '.make-it');
    fs.mkdirSync(makeItDir, { recursive: true });
    fs.writeFileSync(path.join(makeItDir, 'app-context.json'), JSON.stringify({
      project_name: 'TaskHub',
      project_slug: 'task-hub',
      stack: 'fastapi-nextjs',
      project_type: 'web-app',
      features: ['Task management', 'Team dashboards'],
      services: [
        { name: 'backend', port: 8000, health_check: '/health' },
        { name: 'frontend', port: 3000, health_check: '/' }
      ],
      database: { engine: 'postgresql', version: '16' },
      auth: { provider: 'oidc' }
    }));

    const config = loadConfig({ workingDir: FIXTURES });

    expect(config.context.hasMakeIt).toBe(true);
    expect(config.app.name).toBe('TaskHub');
    expect(config.app.slug).toBe('task-hub');
    expect(config.app.stack).toBe('fastapi-nextjs');
    expect(config.app.services).toHaveLength(2);
    expect(config.app.database.engine).toBe('postgresql');
    expect(config.app.auth.provider).toBe('oidc');
  });

  test('ship-it.yml overrides app-context.json values', () => {
    // Set up app-context
    const makeItDir = path.join(FIXTURES, '.make-it');
    fs.mkdirSync(makeItDir, { recursive: true });
    fs.writeFileSync(path.join(makeItDir, 'app-context.json'), JSON.stringify({
      project_name: 'TaskHub',
      project_slug: 'task-hub',
      stack: 'fastapi-nextjs'
    }));

    // Set up ship-it.yml with override
    fs.writeFileSync(path.join(FIXTURES, '.ship-it.yml'), [
      'app:',
      '  name: "TaskHub Pro"',
      '  slug: "task-hub"',
      '  stack: "fastapi-nextjs"'
    ].join('\n'));

    const config = loadConfig({ workingDir: FIXTURES });

    // ship-it.yml value wins
    expect(config.app.name).toBe('TaskHub Pro');
    expect(config.context.hasMakeIt).toBe(true);
    expect(config.context.hasShipItYml).toBe(true);
  });

  test('detects configured AWS infrastructure', () => {
    fs.writeFileSync(path.join(FIXTURES, '.ship-it.yml'), [
      'infra:',
      '  provider: aws',
      '  aws:',
      '    account_id: "123456789012"',
      '    region: us-east-1',
      '    ecs:',
      '      cluster_name: "apps-cluster"'
    ].join('\n'));

    const config = loadConfig({ workingDir: FIXTURES });

    expect(config.infra.configured).toBe(true);
    expect(config.infra.provider).toBe('aws');
  });

  test('marks infra as not configured when account_id is empty', () => {
    fs.writeFileSync(path.join(FIXTURES, '.ship-it.yml'), [
      'infra:',
      '  provider: aws',
      '  aws:',
      '    account_id: ""',
      '    region: us-east-1'
    ].join('\n'));

    const config = loadConfig({ workingDir: FIXTURES });

    expect(config.infra.configured).toBe(false);
  });

  test('loads make-it-state.md and detects build-verified', () => {
    fs.writeFileSync(path.join(FIXTURES, '.make-it-state.md'),
      '# Project State\n## Build-Verify Results\n- Auth flow: PASSED\n');

    const config = loadConfig({ workingDir: FIXTURES });

    expect(config.context.hasMakeItState).toBe(true);
    expect(config.context.buildVerified).toBe(true);
  });

  test('loads deployment config from ship-it.yml', () => {
    fs.writeFileSync(path.join(FIXTURES, '.ship-it.yml'), [
      'deployment:',
      '  environments:',
      '    dev: dev',
      '    production: prod',
      '  reviewers:',
      '    - alice',
      '    - bob',
      '  strategy: blue-green',
      '  rollback: true'
    ].join('\n'));

    const config = loadConfig({ workingDir: FIXTURES });

    expect(config.deployment.reviewers).toEqual(['alice', 'bob']);
    expect(config.deployment.strategy).toBe('blue-green');
    expect(config.deployment.environments.production).toBe('prod');
  });
});

describe('generateShipItYml', () => {
  test('generates yml from merged config', () => {
    const config = {
      app: {
        name: 'TaskHub',
        slug: 'task-hub',
        description: 'Team task management',
        stack: 'fastapi-nextjs',
        projectType: 'web-app',
        services: [
          { name: 'backend', dockerfile: 'backend/Dockerfile', port: 8000, healthCheck: '/health', cpu: 512, memory: 1024 },
          { name: 'frontend', dockerfile: 'frontend/Dockerfile', port: 3000, healthCheck: '/', cpu: 256, memory: 512 }
        ],
        database: { engine: 'postgresql', version: '16' },
        auth: { provider: 'oidc' }
      }
    };

    const yml = generateShipItYml(config);

    expect(yml).toContain('name: "TaskHub"');
    expect(yml).toContain('slug: "task-hub"');
    expect(yml).toContain('stack: "fastapi-nextjs"');
    expect(yml).toContain('name: backend');
    expect(yml).toContain('port: 8000');
    expect(yml).toContain('engine: postgresql');
    expect(yml).toContain('provider: oidc');
    expect(yml).toContain('provider: ""'); // infra section empty
  });
});
