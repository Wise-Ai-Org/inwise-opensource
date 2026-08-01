/**
 * Tests can isolate electron-store without changing production paths. Keeping
 * this in one helper prevents every persisted store from inventing its own
 * environment-variable convention.
 */
export function storeLocationOptions(): { cwd?: string } {
  const cwd = process.env.INWISE_STORE_DIR?.trim();
  return cwd ? { cwd } : {};
}
