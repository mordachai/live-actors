// Shared FilePicker directory-listing cache. Viseme/mask/avatar discovery on
// canvas tokens, talking heads, and video tiles all browse the same folders
// repeatedly (once per token/head, every rebuild) — one cache serves all three
// surfaces instead of re-listing the same directory over and over.
const _folderCache = new Map(); // folder → Promise<string[]>

// Returns the file list for a folder (GM/assistant only — callers already gate
// on FILES_BROWSE permission). Concurrent/repeated calls for the same folder
// share one browse. Resolves to [] on failure without caching the failure, so
// a later call (e.g. after a permission or asset change) can retry.
export function browseFolder(folder) {
  const key = folder || "/";
  let promise = _folderCache.get(key);
  if (!promise) {
    promise = foundry.applications.apps.FilePicker.implementation.browse("data", key)
      .then(result => result.files ?? [])
      .catch(() => {
        _folderCache.delete(key);
        return [];
      });
    _folderCache.set(key, promise);
  }
  return promise;
}

// Clears every cached folder listing — call after adding/renaming asset files
// mid-session (a manual "refresh assets" action) so the next discovery re-lists.
export function clearAssetCache() {
  _folderCache.clear();
}
