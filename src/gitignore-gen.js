/**
 * Generates a .gitignore based on detected stack.
 * Used when a repo has no .gitignore or is missing critical entries.
 */

const GITIGNORE_TEMPLATES = {
  nodejs: `# Dependencies
node_modules/
.pnp.*
.yarn/

# Build
dist/
build/
.next/
out/

# Environment
.env
.env.local
.env.*.local

# IDE
.vscode/settings.json
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*

# Test
coverage/
`,

  python: `# Python
__pycache__/
*.py[cod]
*$py.class
*.egg-info/
dist/
build/
.eggs/

# Virtual environments
venv/
.venv/
env/

# Environment
.env
.env.local

# IDE
.vscode/settings.json
.idea/
*.swp

# OS
.DS_Store
Thumbs.db

# Test
.pytest_cache/
htmlcov/
.coverage
`,

  'fastapi-nextjs': `# Dependencies
node_modules/
__pycache__/
*.py[cod]
*.egg-info/

# Build
dist/
build/
.next/
out/

# Virtual environments
venv/
.venv/

# Environment
.env
.env.local
.env.*.local

# IDE
.vscode/settings.json
.idea/
*.swp

# OS
.DS_Store
Thumbs.db

# Logs
*.log

# Test
coverage/
.pytest_cache/
htmlcov/
.coverage

# Docker
.docker/
`,

  go: `# Binary
/bin/
*.exe
*.dll
*.so
*.dylib

# Test
*.test
*.out
coverage.txt

# Environment
.env

# IDE
.vscode/settings.json
.idea/
*.swp

# OS
.DS_Store
Thumbs.db

# Vendor (if not committing)
# vendor/
`,

  rust: `# Build
/target/

# Environment
.env

# IDE
.vscode/settings.json
.idea/
*.swp

# OS
.DS_Store
Thumbs.db
`,

  container: `# Environment
.env
.env.local
.env.*.local

# IDE
.vscode/settings.json
.idea/
*.swp

# OS
.DS_Store
Thumbs.db

# Docker
.docker/
`,

  default: `# Environment
.env
.env.local

# IDE
.vscode/settings.json
.idea/
*.swp

# OS
.DS_Store
Thumbs.db

# Logs
*.log
`
};

// Critical entries that MUST exist per stack
const CRITICAL_ENTRIES = {
  nodejs: ['node_modules/', '.env'],
  nextjs: ['node_modules/', '.next/', '.env'],
  'fastapi-nextjs': ['node_modules/', '__pycache__/', '.env', '.next/'],
  python: ['__pycache__/', '.env', 'venv/', '.venv/'],
  go: ['.env'],
  rust: ['/target/', '.env'],
  container: ['.env'],
  default: ['.env']
};

/**
 * Generate a complete .gitignore for the given stack.
 */
function generateGitignore(stack) {
  return GITIGNORE_TEMPLATES[stack] || GITIGNORE_TEMPLATES.default;
}

/**
 * Check if an existing .gitignore is missing critical entries for the stack.
 * Returns an array of missing entries that should be appended.
 */
function getMissingEntries(existingContent, stack) {
  const critical = CRITICAL_ENTRIES[stack] || CRITICAL_ENTRIES.default;
  const lines = existingContent.split('\n').map(l => l.trim());

  return critical.filter(entry => {
    // Check if the entry (or a variant) is already present
    const normalized = entry.replace(/\/$/, '');
    return !lines.some(line =>
      line === entry ||
      line === normalized ||
      line === `/${entry}` ||
      line === `/${normalized}`
    );
  });
}

module.exports = { generateGitignore, getMissingEntries };
