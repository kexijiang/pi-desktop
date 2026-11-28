import { MAX_RUN_PATCH_BYTES, MAX_RUN_PATCH_FILES, type RunFilePatchDetail } from "./run-patch";

type PatchResult = RunFilePatchDetail & { patchRevision: string };

interface CachedPatch {
  version: string;
  bytes: number;
  result: PatchResult;
}

/** Keep only the latest cached patch for a file, with one shared budget per run. */
export class RunPatchCache {
  private readonly files = new Map<string, CachedPatch>();
  private bytes = 0;

  constructor(
    private readonly maxBytes = MAX_RUN_PATCH_BYTES,
    private readonly maxFiles = MAX_RUN_PATCH_FILES,
  ) {}

  get(file: string, version: string): PatchResult | undefined {
    const entry = this.files.get(file);
    if (!entry) return undefined;
    this.remove(file, entry);
    if (entry.version !== version) return undefined;
    this.files.set(file, entry);
    this.bytes += entry.bytes;
    return entry.result;
  }

  set(file: string, version: string, result: PatchResult): void {
    const previous = this.files.get(file);
    if (previous) this.remove(file, previous);
    const bytes = Buffer.byteLength(result.patch);
    if (bytes > this.maxBytes || this.maxFiles <= 0) return;
    this.files.set(file, { version, bytes, result });
    this.bytes += bytes;
    for (const [oldest, entry] of this.files) {
      if (this.bytes <= this.maxBytes && this.files.size <= this.maxFiles) break;
      this.remove(oldest, entry);
    }
  }

  private remove(file: string, entry: CachedPatch): void {
    this.files.delete(file);
    this.bytes -= entry.bytes;
  }
}
