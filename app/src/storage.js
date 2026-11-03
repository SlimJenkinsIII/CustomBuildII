// Where the encrypted data is kept on this device. Only ever holds the encrypted envelope.
// Two stores with the same shape, so everything else can be tested without a browser:
//   memoryStorage()    - nothing survives a reload (used in tests and the preview page)
//   indexedDbStorage() - the browser's own database on this device

export function memoryStorage() {
  let envelope = null;
  return { persistent: false, async load() { return envelope; }, async save(e) { envelope = e; }, async clear() { envelope = null; }, async requestPersistence() { return false; } };
}

export function indexedDbStorage(dbName = 'my-budget', store = 'vault', key = 'envelope') {
  const open = () => new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = async (mode, action) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = action(tx.objectStore(store));
      tx.oncomplete = () => { db.close(); resolve(req.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    });
  };
  return {
    persistent: true,
    load: () => run('readonly', s => s.get(key)).then(v => v ?? null),
    save: envelope => run('readwrite', s => s.put(envelope, key)),
    clear: () => run('readwrite', s => s.delete(key)),
    // Asks the browser not to clear this data when space is tight. Safari is more likely to agree once
    // the app is added to the Home Screen.
    async requestPersistence() {
      try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { return false; }
    },
  };
}
