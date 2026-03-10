const { handleAuthError, getAuthFixInstructions } = require('../auth-handler');

describe('handleAuthError', () => {
  test('returns login instructions for 401', () => {
    const msg = handleAuthError({ status: 401 });
    expect(msg).toContain('gh auth login');
  });

  test('returns rate limit message for 403 rate limit', () => {
    const msg = handleAuthError({ status: 403, message: 'API rate limit exceeded' });
    expect(msg).toContain('slow down');
  });

  test('returns permission message for 403 non-rate-limit', () => {
    const msg = handleAuthError({ status: 403, message: 'Resource not accessible' });
    expect(msg).toContain('permission');
  });

  test('returns generic message for other errors', () => {
    const msg = handleAuthError({ status: 500, message: 'Server error' });
    expect(msg).toContain('Server error');
  });
});

describe('getAuthFixInstructions', () => {
  test('returns brew install for macOS', () => {
    const instructions = getAuthFixInstructions('darwin');
    expect(instructions.installCommand).toContain('brew');
  });

  test('returns apt install for linux', () => {
    const instructions = getAuthFixInstructions('linux');
    expect(instructions.installCommand).toContain('apt');
  });

  test('returns winget for windows', () => {
    const instructions = getAuthFixInstructions('win32');
    expect(instructions.installCommand).toContain('winget');
  });

  test('all platforms include login command', () => {
    ['darwin', 'linux', 'win32'].forEach(platform => {
      const instructions = getAuthFixInstructions(platform);
      expect(instructions.loginCommand).toBe('gh auth login');
    });
  });
});
