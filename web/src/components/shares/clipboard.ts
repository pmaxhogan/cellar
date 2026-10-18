/**
 * Copy text to the clipboard. Resolves false instead of throwing when the
 * browser refuses (no permission, insecure context, no Clipboard API), so the
 * caller can still show the text for a manual copy.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard === undefined) return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
