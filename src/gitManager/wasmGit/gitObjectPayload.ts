/**
 * Git object-store paths whose contents are large (packs, loose objects).
 * Metadata under `.git` (HEAD, index, refs, config) is not included.
 *
 * The object store is paged in only when libgit2 needs the ODB, so a status
 * refresh cannot copy every pack into MEMFS and jetsam iOS.
 */
export function isGitObjectPayloadPath(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, "/");
    return normalized === "objects" || normalized.startsWith("objects/");
}
