/** Shader rejection is different from low FPS. Remember failed layouts because Three caches
 * failed programs too; retrying one must not silently leave the scene blank. */
export class DetailedLightTrial {
  private readonly rejected = new Set<string>();
  private key = "";
  private experimenting = false;
  private pending: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly recover: () => void) {}

  configure(point: number, spot: number, recommendation: number, enabled: boolean): boolean {
    this.key = `${point}:${spot}`;
    this.experimenting = enabled && point + spot > recommendation;
    if (this.experimenting && this.rejected.has(this.key)) {
      this.reject();
      return false;
    }
    return true;
  }

  reject(): boolean {
    if (!this.experimenting) return false;
    this.rejected.add(this.key);
    this.pending ??= setTimeout(() => { this.pending = null; this.recover(); }, 0);
    return true;
  }

  dispose(): void {
    if (this.pending !== null) clearTimeout(this.pending);
    this.pending = null;
  }
}
