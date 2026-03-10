/**
 * Translates authentication/authorization errors into plain-language
 * messages with actionable fix instructions.
 */
function handleAuthError(error) {
  if (error.status === 401) {
    return (
      'Looks like GitHub didn\'t accept your credentials.\n' +
      'Try running: gh auth login\n' +
      'Then run /ship-it again.'
    );
  }

  if (error.status === 403) {
    if (error.message?.includes('rate limit')) {
      return (
        'GitHub is asking us to slow down (rate limit reached).\n' +
        'Try again in a few minutes.'
      );
    }
    return (
      'GitHub says you don\'t have permission for this action.\n' +
      'Make sure you have write access to this repo.\n' +
      'If you just got added, try: gh auth refresh'
    );
  }

  return `Something went wrong talking to GitHub: ${error.message}`;
}

/**
 * Checks if the gh CLI is authenticated. Returns a plain-language
 * message if there's a problem, or null if everything is fine.
 */
function getAuthFixInstructions(platform) {
  const install = {
    darwin: 'brew install gh',
    linux: 'sudo apt install gh   (or: sudo dnf install gh)',
    win32: 'winget install GitHub.cli'
  };

  return {
    installCommand: install[platform] || install.linux,
    loginCommand: 'gh auth login',
    refreshCommand: 'gh auth refresh'
  };
}

module.exports = { handleAuthError, getAuthFixInstructions };
