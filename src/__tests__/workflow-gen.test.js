const { generateWorkflow, generateAcaWorkflows } = require('../workflow-gen');

// --- Helpers to build config objects ---

function makeConfig(overrides = {}) {
  return {
    app: { slug: 'myapp', services: [], ...overrides.app },
    infra: { configured: false, provider: '', ...overrides.infra },
    deployment: {
      environments: { dev: 'dev', production: 'production' },
      reusableWorkflow: null,
      ...overrides.deployment,
    },
  };
}

function awsService(name, dockerfile) {
  return { name, dockerfile: dockerfile || `${name}/Dockerfile`, healthCheck: '/health' };
}

// --- Tests ---

describe('generateWorkflow', () => {

  describe('no config (null)', () => {
    test('returns basic workflow from template', () => {
      const result = generateWorkflow(null);

      expect(result).toContain('name: ship-it pipeline');
      expect(result).toContain('actions/checkout@v4');
      expect(result).toContain('deploy-dev');
      expect(result).toContain('deploy-prod');
      expect(result).toContain('environment: dev');
    });

    test('replaces template placeholders', () => {
      const result = generateWorkflow(null);

      expect(result).not.toContain('{{BUILD_CMD}}');
      expect(result).not.toContain('{{LINT_CMD}}');
      expect(result).not.toContain('{{SECURITY_CMD}}');
      expect(result).not.toContain('{{DEV_ENV}}');
      expect(result).not.toContain('{{PROD_ENV}}');
    });
  });

  describe('reusable workflow configured', () => {
    test('returns caller workflow with uses: line and secrets: inherit', () => {
      const config = makeConfig({
        deployment: {
          reusableWorkflow: 'my-org/shared-pipelines/.github/workflows/deploy.yml@main',
          environments: { dev: 'dev', production: 'production' },
        },
      });

      const result = generateWorkflow(config);

      expect(result).toContain('uses: my-org/shared-pipelines/.github/workflows/deploy.yml@main');
      expect(result).toContain('secrets: inherit');
      expect(result).toContain('environment-dev: dev');
      expect(result).toContain('environment-prod: production');
    });

    test('does not contain full deploy jobs', () => {
      const config = makeConfig({
        deployment: {
          reusableWorkflow: 'org/repo/.github/workflows/ci.yml@main',
          environments: { dev: 'dev', production: 'production' },
        },
      });

      const result = generateWorkflow(config);

      expect(result).not.toContain('deploy-dev');
      expect(result).not.toContain('deploy-prod');
      expect(result).not.toContain('docker build');
    });
  });

  describe('AWS infra configured', () => {
    const awsConfig = makeConfig({
      app: {
        slug: 'taskhub',
        services: [
          awsService('backend', 'backend/Dockerfile'),
          awsService('frontend', 'frontend/Dockerfile'),
        ],
      },
      infra: {
        configured: true,
        provider: 'aws',
        aws: {
          account_id: '123456789012',
          region: 'us-west-2',
          ecr_registry: '123456789012.dkr.ecr.us-west-2.amazonaws.com',
          ecs: { cluster_name: 'apps-cluster' },
        },
      },
    });

    test('has ECR login step', () => {
      const result = generateWorkflow(awsConfig);
      expect(result).toContain('amazon-ecr-login@v2');
    });

    test('has configure-aws-credentials step', () => {
      const result = generateWorkflow(awsConfig);
      expect(result).toContain('aws-actions/configure-aws-credentials@v4');
    });

    test('has docker build per service', () => {
      const result = generateWorkflow(awsConfig);
      expect(result).toContain('Build backend image');
      expect(result).toContain('Build frontend image');
      expect(result).toContain('docker build');
    });

    test('has ecs update-service', () => {
      const result = generateWorkflow(awsConfig);
      expect(result).toContain('aws ecs update-service');
    });

    test('includes cluster name', () => {
      const result = generateWorkflow(awsConfig);
      expect(result).toContain('ECS_CLUSTER: apps-cluster');
      expect(result).toContain('--cluster apps-cluster');
    });

    test('has deploy-dev and deploy-prod jobs', () => {
      const result = generateWorkflow(awsConfig);
      expect(result).toContain('deploy-dev');
      expect(result).toContain('deploy-prod');
      expect(result).toContain('Deploy to Dev');
      expect(result).toContain('Deploy to Production');
    });

    test('uses configured region', () => {
      const result = generateWorkflow(awsConfig);
      expect(result).toContain('AWS_REGION: us-west-2');
    });

    test('uses configured ECR registry', () => {
      const result = generateWorkflow(awsConfig);
      expect(result).toContain('ECR_REGISTRY: 123456789012.dkr.ecr.us-west-2.amazonaws.com');
    });
  });

  describe('AWS with single service', () => {
    test('only one Build step', () => {
      const config = makeConfig({
        app: {
          slug: 'api',
          services: [awsService('api', 'Dockerfile')],
        },
        infra: {
          configured: true,
          provider: 'aws',
          aws: {
            account_id: '111111111111',
            region: 'us-east-1',
            ecs: { cluster_name: 'cluster' },
          },
        },
      });

      const result = generateWorkflow(config);
      const buildMatches = result.match(/Build .+ image/g);

      expect(buildMatches).toHaveLength(1);
      expect(buildMatches[0]).toBe('Build api image');
    });
  });

  describe('AWS with multiple services', () => {
    test('one Build step per service', () => {
      const config = makeConfig({
        app: {
          slug: 'platform',
          services: [
            awsService('web'),
            awsService('api'),
            awsService('worker'),
          ],
        },
        infra: {
          configured: true,
          provider: 'aws',
          aws: {
            account_id: '222222222222',
            region: 'eu-west-1',
            ecs: { cluster_name: 'eu-cluster' },
          },
        },
      });

      const result = generateWorkflow(config);
      const buildMatches = result.match(/Build .+ image/g);

      expect(buildMatches).toHaveLength(3);
      expect(result).toContain('Build web image');
      expect(result).toContain('Build api image');
      expect(result).toContain('Build worker image');
    });
  });

  describe('Azure infra configured', () => {
    const azureConfig = makeConfig({
      app: {
        slug: 'portal',
        services: [
          awsService('backend', 'backend/Dockerfile'),
          awsService('frontend', 'frontend/Dockerfile'),
        ],
      },
      infra: {
        configured: true,
        provider: 'azure',
        azure: {
          acr_name: 'myacr',
          acr_login_server: 'myacr.azurecr.io',
          aks: { cluster_name: 'aks-prod', resource_group: 'rg-portal' },
        },
      },
    });

    test('has azure/login step', () => {
      const result = generateWorkflow(azureConfig);
      expect(result).toContain('azure/login@v2');
    });

    test('has az acr login step', () => {
      const result = generateWorkflow(azureConfig);
      expect(result).toContain('az acr login --name myacr');
    });

    test('has docker build per service', () => {
      const result = generateWorkflow(azureConfig);
      expect(result).toContain('Build backend image');
      expect(result).toContain('Build frontend image');
      expect(result).toContain('docker build');
    });

    test('has kubectl set image for deployment', () => {
      const result = generateWorkflow(azureConfig);
      expect(result).toContain('kubectl set image');
    });

    test('includes AKS cluster details', () => {
      const result = generateWorkflow(azureConfig);
      expect(result).toContain('AKS_CLUSTER: aks-prod');
      expect(result).toContain('AKS_RESOURCE_GROUP: rg-portal');
    });

    test('uses ACR login server in image tags', () => {
      const result = generateWorkflow(azureConfig);
      expect(result).toContain('myacr.azurecr.io/portal-backend');
      expect(result).toContain('myacr.azurecr.io/portal-frontend');
    });

    test('does not contain AWS-specific steps', () => {
      const result = generateWorkflow(azureConfig);
      expect(result).not.toContain('amazon-ecr-login');
      expect(result).not.toContain('aws ecs');
      expect(result).not.toContain('ECR_REGISTRY');
    });
  });

  describe('no infra configured', () => {
    test('returns pending workflow with placeholder', () => {
      const config = makeConfig();

      const result = generateWorkflow(config);

      expect(result).toContain('Deployment pending');
      expect(result).toContain('.ship-it.yml');
    });

    test('does not contain cloud-specific steps', () => {
      const config = makeConfig();

      const result = generateWorkflow(config);

      expect(result).not.toContain('amazon-ecr-login');
      expect(result).not.toContain('azure/login');
      expect(result).not.toContain('docker build');
      expect(result).not.toContain('kubectl');
      expect(result).not.toContain('aws ecs');
    });

    test('still has deploy-dev and deploy-prod jobs', () => {
      const config = makeConfig();

      const result = generateWorkflow(config);

      expect(result).toContain('deploy-dev');
      expect(result).toContain('deploy-prod');
    });
  });

  describe('custom environment names', () => {
    test('passes through to reusable workflow', () => {
      const config = makeConfig({
        deployment: {
          reusableWorkflow: 'org/repo/.github/workflows/ci.yml@main',
          environments: { dev: 'staging', production: 'prod-us-east' },
        },
      });

      const result = generateWorkflow(config);

      expect(result).toContain('environment-dev: staging');
      expect(result).toContain('environment-prod: prod-us-east');
    });

    test('passes through to AWS workflow', () => {
      const config = makeConfig({
        app: {
          slug: 'myapp',
          services: [awsService('api')],
        },
        infra: {
          configured: true,
          provider: 'aws',
          aws: { account_id: '111', region: 'us-east-1', ecs: { cluster_name: 'c' } },
        },
        deployment: {
          environments: { dev: 'qa', production: 'live' },
        },
      });

      const result = generateWorkflow(config);

      expect(result).toContain('environment: qa');
      expect(result).toContain('name: live');
    });

    test('passes through to Azure workflow', () => {
      const config = makeConfig({
        app: {
          slug: 'myapp',
          services: [awsService('api')],
        },
        infra: {
          configured: true,
          provider: 'azure',
          azure: { acr_name: 'acr', aks: { cluster_name: 'aks', resource_group: 'rg' } },
        },
        deployment: {
          environments: { dev: 'int', production: 'prod-west' },
        },
      });

      const result = generateWorkflow(config);

      expect(result).toContain('environment: int');
      expect(result).toContain('name: prod-west');
    });

    test('passes through to pending workflow', () => {
      const config = makeConfig({
        deployment: {
          environments: { dev: 'test-env', production: 'release' },
        },
      });

      const result = generateWorkflow(config);

      expect(result).toContain('environment: test-env');
      expect(result).toContain('name: release');
    });
  });

  describe('Azure ACA with reusable workflows', () => {
    const acaConfig = makeConfig({
      app: { slug: 'capacity-planner' },
      infra: {
        provider: 'azure',
        deployTarget: 'aca',
        azure: {
          app_path: './apps/typescript',
          app_type: 'node',
          node_version: '20',
          first_env: 'dev',
          container_app_name: 'capacity-planner',
        },
      },
      deployment: {
        environments: { dev: 'dev', production: 'prd' },
        reusableWorkflows: {
          ci: 'SleepNumberInc/container-app-ci-gha-workflow/.github/workflows/container-app-ci.yaml@v1',
          cd: 'SleepNumberInc/container-app-cd-gha-workflow/.github/workflows/container-app-cd.yaml@v1',
          pr_lint: 'SleepNumberInc/cicd-workflows/.github/workflows/pr_lint.yml@v1',
          pr_validate: 'SleepNumberInc/pull-request-external-task-validation/.github/workflows/pr_external_validation.yaml@v1',
        },
      },
    });

    test('returns object with files array', () => {
      const result = generateWorkflow(acaConfig);
      expect(result).toHaveProperty('files');
      expect(Array.isArray(result.files)).toBe(true);
    });

    test('generates CI, CD, and PR lint workflows', () => {
      const result = generateWorkflow(acaConfig);
      const paths = result.files.map(f => f.path);
      expect(paths).toContain('.github/workflows/container-app-ci.yml');
      expect(paths).toContain('.github/workflows/container-app-cd.yml');
      expect(paths).toContain('.github/workflows/pr_lint.yaml');
    });

    test('CI workflow uses reusable CI workflow', () => {
      const result = generateWorkflow(acaConfig);
      const ci = result.files.find(f => f.path.includes('ci.yml'));
      expect(ci.content).toContain('uses: SleepNumberInc/container-app-ci-gha-workflow');
      expect(ci.content).toContain("app_name: 'capacity-planner'");
      expect(ci.content).toContain("app_path: './apps/typescript'");
      expect(ci.content).toContain("app_type: 'node'");
      expect(ci.content).toContain("node_version: '20'");
      expect(ci.content).toContain("first_env: 'dev'");
      expect(ci.content).toContain('secrets: inherit');
    });

    test('CD workflow uses reusable CD workflow', () => {
      const result = generateWorkflow(acaConfig);
      const cd = result.files.find(f => f.path.includes('cd.yml'));
      expect(cd.content).toContain('uses: SleepNumberInc/container-app-cd-gha-workflow');
      expect(cd.content).toContain("app_name: 'capacity-planner'");
      expect(cd.content).toContain("app_path: './apps/typescript'");
      expect(cd.content).toContain('on:\n  deployment:');
      expect(cd.content).toContain('secrets: inherit');
    });

    test('CD workflow has actor gate', () => {
      const result = generateWorkflow(acaConfig);
      const cd = result.files.find(f => f.path.includes('cd.yml'));
      expect(cd.content).toContain('SleepNumberDevOps');
      expect(cd.content).toContain('clouddevopsdeploymentreadwrite[bot]');
    });

    test('PR lint uses org reusable workflows', () => {
      const result = generateWorkflow(acaConfig);
      const lint = result.files.find(f => f.path.includes('pr_lint'));
      expect(lint.content).toContain('uses: SleepNumberInc/cicd-workflows');
      expect(lint.content).toContain('uses: SleepNumberInc/pull-request-external-task-validation');
    });

    test('does not contain AKS or AWS steps', () => {
      const result = generateWorkflow(acaConfig);
      const allContent = result.files.map(f => f.content).join('\n');
      expect(allContent).not.toContain('kubectl');
      expect(allContent).not.toContain('aws ecs');
      expect(allContent).not.toContain('amazon-ecr');
      expect(allContent).not.toContain('AKS_CLUSTER');
    });

    test('skips PR lint when no pr_lint workflow configured', () => {
      const config = makeConfig({
        app: { slug: 'myapp' },
        infra: {
          provider: 'azure',
          deployTarget: 'aca',
          azure: { container_app_name: 'myapp', app_path: '.' },
        },
        deployment: {
          environments: { dev: 'dev', production: 'prd' },
          reusableWorkflows: {
            ci: 'org/ci-repo/.github/workflows/ci.yaml@v1',
            cd: 'org/cd-repo/.github/workflows/cd.yaml@v1',
          },
        },
      });

      const result = generateWorkflow(config);
      const paths = result.files.map(f => f.path);
      expect(paths).toHaveLength(2);
      expect(paths).not.toContain('.github/workflows/pr_lint.yaml');
    });

    test('omits node_version for python app_type', () => {
      const config = makeConfig({
        app: { slug: 'pyapp' },
        infra: {
          provider: 'azure',
          deployTarget: 'aca',
          azure: {
            container_app_name: 'pyapp',
            app_path: '.',
            app_type: 'python',
          },
        },
        deployment: {
          environments: { dev: 'dev', production: 'prd' },
          reusableWorkflows: {
            ci: 'org/ci/.github/workflows/ci.yaml@v1',
            cd: 'org/cd/.github/workflows/cd.yaml@v1',
          },
        },
      });

      const result = generateWorkflow(config);
      const ci = result.files.find(f => f.path.includes('ci.yml'));
      expect(ci.content).toContain("app_type: 'python'");
      expect(ci.content).not.toContain('node_version');
    });
  });
});
