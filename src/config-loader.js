const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Loads and merges configuration from multiple sources:
 *   1. .ship-it.yml (highest priority -- DevOps overrides)
 *   2. app-context.json (from /make-it)
 *   3. Auto-detected values (stack, git context)
 *   4. Sensible defaults (lowest priority)
 *
 * Returns a unified config object used by workflow-gen and pr-builder.
 */
function loadConfig({ workingDir = '.' } = {}) {
  const shipItYml = loadShipItYml(workingDir);
  const appContext = loadAppContext(workingDir);
  const makeItState = loadMakeItState(workingDir);
  const detected = detectStack(workingDir);

  return mergeConfig({ shipItYml, appContext, makeItState, detected });
}

// --- File loaders ---

function loadShipItYml(workingDir) {
  const filePath = path.join(workingDir, '.ship-it.yml');
  if (!fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return yaml.load(content) || null;
  } catch {
    return null;
  }
}

function loadAppContext(workingDir) {
  // Try both paths: .make-it/app-context.json and app-context.json
  const paths = [
    path.join(workingDir, '.make-it', 'app-context.json'),
    path.join(workingDir, 'app-context.json')
  ];

  for (const filePath of paths) {
    if (fs.existsSync(filePath)) {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        continue;
      }
    }
  }
  return null;
}

function loadMakeItState(workingDir) {
  const filePath = path.join(workingDir, '.make-it-state.md');
  if (!fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return {
      exists: true,
      content,
      buildVerified: content.includes('Build-Verify Results') || content.includes('PASSED'),
      prodReady: content.includes('prod-ready') || content.includes('ready for production')
    };
  } catch {
    return null;
  }
}

function detectStack(workingDir) {
  const detected = { stack: null, projectType: null, files: [] };
  const checks = [
    { file: 'package.json', extra: 'next.config.*', stack: null },
    { file: 'requirements.txt', stack: 'python' },
    { file: 'pyproject.toml', stack: 'python' },
    { file: 'go.mod', stack: 'go' },
    { file: 'Cargo.toml', stack: 'rust' },
    { file: 'docker-compose.yml', stack: 'container' },
    { file: 'Dockerfile', stack: 'container' }
  ];

  for (const check of checks) {
    if (fs.existsSync(path.join(workingDir, check.file))) {
      detected.files.push(check.file);
    }
  }

  // Determine stack from found files
  if (detected.files.includes('package.json')) {
    // Check for Next.js
    const nextConfigs = ['next.config.js', 'next.config.ts', 'next.config.mjs'];
    const hasNext = nextConfigs.some(f => fs.existsSync(path.join(workingDir, f)));

    if (hasNext && (detected.files.includes('requirements.txt') || detected.files.includes('pyproject.toml'))) {
      detected.stack = 'fastapi-nextjs';
    } else if (hasNext) {
      detected.stack = 'nextjs';
    } else {
      detected.stack = 'nodejs';
    }
  } else if (detected.files.includes('requirements.txt') || detected.files.includes('pyproject.toml')) {
    detected.stack = 'python';
  } else if (detected.files.includes('go.mod')) {
    detected.stack = 'go';
  } else if (detected.files.includes('Cargo.toml')) {
    detected.stack = 'rust';
  }

  if (detected.files.includes('docker-compose.yml')) {
    detected.projectType = 'container-multi';
  } else if (detected.files.includes('Dockerfile')) {
    detected.projectType = 'container-single';
  }

  return detected;
}

// --- Merge logic ---

/**
 * Merge priority (highest wins):
 *   1. .ship-it.yml
 *   2. app-context.json
 *   3. Auto-detected
 *   4. Defaults
 */
function mergeConfig({ shipItYml, appContext, makeItState, detected }) {
  const config = {
    app: {
      name: '',
      slug: '',
      description: '',
      stack: '',
      projectType: '',
      services: [],
      database: { engine: 'none', version: '' },
      auth: { provider: 'none' }
    },
    infra: {
      provider: '',
      configured: false
    },
    deployment: {
      environments: { dev: 'dev', production: 'production' },
      reviewers: [],
      prerequisites: [],
      reusableWorkflow: null,
      strategy: 'rolling',
      rollback: true
    },
    context: {
      hasMakeIt: !!appContext,
      hasMakeItState: !!makeItState,
      hasShipItYml: !!shipItYml,
      buildVerified: makeItState?.buildVerified || false,
      prodReady: makeItState?.prodReady || false,
      detectedStack: detected.stack,
      detectedFiles: detected.files
    }
  };

  // Layer 4: Defaults (already set above)

  // Layer 3: Auto-detected
  if (detected.stack) config.app.stack = detected.stack;
  if (detected.projectType) config.app.projectType = detected.projectType;

  // Layer 2: app-context.json
  if (appContext) {
    if (appContext.project_name) config.app.name = appContext.project_name;
    if (appContext.project_slug) config.app.slug = appContext.project_slug;
    if (appContext.stack) config.app.stack = appContext.stack;
    if (appContext.project_type) config.app.projectType = appContext.project_type;

    if (appContext.features) {
      config.app.description = summarizeFeatures(appContext.features);
    }

    if (appContext.services && Array.isArray(appContext.services)) {
      config.app.services = appContext.services.map(s => ({
        name: s.name || '',
        dockerfile: s.dockerfile || `${s.name}/Dockerfile`,
        port: s.port || 0,
        healthCheck: s.health_check || '/',
        cpu: s.cpu || 256,
        memory: s.memory || 512
      }));
    }

    if (appContext.database) {
      config.app.database.engine = appContext.database.engine || 'none';
      config.app.database.version = appContext.database.version || '';
    }

    if (appContext.auth) {
      config.app.auth.provider = appContext.auth.provider || 'none';
    }
  }

  // Layer 1: .ship-it.yml (highest priority)
  if (shipItYml) {
    const app = shipItYml.app || {};
    if (app.name) config.app.name = app.name;
    if (app.slug) config.app.slug = app.slug;
    if (app.description) config.app.description = app.description;
    if (app.stack) config.app.stack = app.stack;
    if (app.project_type) config.app.projectType = app.project_type;

    if (app.services && Array.isArray(app.services)) {
      config.app.services = app.services.map(s => ({
        name: s.name || '',
        dockerfile: s.dockerfile || `${s.name}/Dockerfile`,
        port: s.port || 0,
        healthCheck: s.health_check || '/',
        cpu: s.cpu || 256,
        memory: s.memory || 512
      }));
    }

    if (app.database) {
      if (app.database.engine) config.app.database.engine = app.database.engine;
      if (app.database.version) config.app.database.version = app.database.version;
    }

    if (app.auth) {
      if (app.auth.provider) config.app.auth.provider = app.auth.provider;
    }

    // Infra section
    const infra = shipItYml.infra || {};
    if (infra.provider) {
      config.infra.provider = infra.provider;
      config.infra.configured = isInfraConfigured(infra);

      // Pass through the full provider-specific config
      if (infra.aws) config.infra.aws = infra.aws;
      if (infra.azure) config.infra.azure = infra.azure;
      if (infra.gcp) config.infra.gcp = infra.gcp;
    }

    // Deployment section
    const deploy = shipItYml.deployment || {};
    if (deploy.environments) config.deployment.environments = deploy.environments;
    if (deploy.reviewers) config.deployment.reviewers = deploy.reviewers;
    if (deploy.prerequisites) config.deployment.prerequisites = deploy.prerequisites;
    if (deploy.reusable_workflow) config.deployment.reusableWorkflow = deploy.reusable_workflow;
    if (deploy.strategy) config.deployment.strategy = deploy.strategy;
    if (deploy.rollback !== undefined) config.deployment.rollback = deploy.rollback;
  }

  return config;
}

// --- Helpers ---

function isInfraConfigured(infra) {
  if (!infra.provider) return false;

  if (infra.provider === 'aws' && infra.aws) {
    // Must have at minimum: account_id and cluster_name
    return !!(infra.aws.account_id && infra.aws.ecs?.cluster_name);
  }

  if (infra.provider === 'azure' && infra.azure) {
    // Must have at minimum: subscription_id and acr_name
    return !!(infra.azure.subscription_id && infra.azure.acr_name);
  }

  return false;
}

function summarizeFeatures(features) {
  if (typeof features === 'string') return features;
  if (Array.isArray(features)) {
    if (features.length <= 3) return features.join(', ');
    return features.slice(0, 3).join(', ') + ` and ${features.length - 3} more`;
  }
  return '';
}


/**
 * Generate a .ship-it.yml app section from app-context.json.
 * Used when /ship-it runs on a project that has app-context but no .ship-it.yml.
 */
function generateShipItYml(config) {
  const app = config.app;
  const lines = [
    '# .ship-it.yml -- Generated by /ship-it from app-context.json',
    '#',
    '# The `app` section describes what is being deployed.',
    '# The `infra` section is for DevOps to fill in with cloud infrastructure details.',
    '# See: https://github.com/sealmindset/ship-it/blob/main/docs/devops-guide.md',
    '',
    'app:',
    `  name: "${app.name}"`,
    `  slug: "${app.slug}"`,
    `  description: "${app.description}"`,
    `  stack: "${app.stack}"`,
    `  project_type: "${app.projectType}"`,
  ];

  if (app.services.length > 0) {
    lines.push('  services:');
    for (const svc of app.services) {
      lines.push(`    - name: ${svc.name}`);
      lines.push(`      dockerfile: ${svc.dockerfile}`);
      lines.push(`      port: ${svc.port}`);
      lines.push(`      health_check: ${svc.healthCheck}`);
      lines.push(`      cpu: ${svc.cpu}`);
      lines.push(`      memory: ${svc.memory}`);
    }
  }

  lines.push('  database:');
  lines.push(`    engine: ${app.database.engine}`);
  if (app.database.version) lines.push(`    version: "${app.database.version}"`);

  lines.push('  auth:');
  lines.push(`    provider: ${app.auth.provider}`);

  lines.push('');
  lines.push('# INFRA -- Pending DevOps configuration');
  lines.push('# Copy your org\'s infra template from:');
  lines.push('#   templates/ship-it-aws.yml  (AWS)');
  lines.push('#   templates/ship-it-azure.yml (Azure)');
  lines.push('infra:');
  lines.push('  provider: ""');
  lines.push('');
  lines.push('# DEPLOYMENT -- Pipeline defaults');
  lines.push('deployment:');
  lines.push('  environments:');
  lines.push('    dev: dev');
  lines.push('    production: production');
  lines.push('  reviewers: []');
  lines.push('  strategy: rolling');
  lines.push('  rollback: true');

  return lines.join('\n') + '\n';
}

module.exports = { loadConfig, generateShipItYml, loadAppContext, loadMakeItState, detectStack };
