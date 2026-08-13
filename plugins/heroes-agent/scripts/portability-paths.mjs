export function collectScannableTrackedPaths(stagedEntries, trackedPaths, errors) {
  const trackedSymlinks = new Set();
  for (const entry of stagedEntries) {
    const tab = entry.indexOf('\t');
    const metadata = tab === -1 ? entry : entry.slice(0, tab);
    const path = tab === -1 ? entry : entry.slice(tab + 1);
    if (metadata.startsWith('120000 ')) {
      errors.push(`tracked-symlink: ${path}`);
      trackedSymlinks.add(path);
    }
  }
  return trackedPaths.filter((path) => !trackedSymlinks.has(path));
}
