// Words that depend on the system the app runs on (the desktop app runs on macOS, Linux and Windows).

const ua = () => (typeof navigator === 'undefined' ? '' : `${navigator.platform || ''} ${navigator.userAgent || ''}`);

/**
 * Where keys are kept on this system: the macOS Keychain; on Linux the system keyring (secret-tool), or an encrypted
 * file in the data folder when no keyring answers; an encrypted file elsewhere (Windows).
 */
export function secureStore(): string {
  if (/Mac|iPhone|iPad/.test(ua())) return 'the macOS Keychain';
  if (/Linux/.test(ua()) && !/Android/.test(ua())) return 'the system keyring (or an encrypted file in the data folder when no keyring runs)';
  return 'an encrypted file in the data folder';
}

/** Where the app's icon sits while its window is closed: the menu bar on a Mac, the system tray elsewhere. */
export function trayName(): string {
  return /Mac/.test(ua()) ? 'menu bar' : 'system tray';
}
