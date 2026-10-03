@Injectable()
export class Repo<T extends object = {}> {
  #cache = new Map<string, T>();
  static readonly TTL = 1_000n * 60n;
  private handlers: Array<(e: Event) => void> = [];
  find = (id: string): T | undefined => this.#cache.get(id);
  get size(): number { return this.#cache.size; }
  async save(item: T, opts?: { force: boolean }): Promise<void> {
    if (opts?.force ?? false) { this.#cache.clear(); }
  }
}

export function sentinel(a: number) {
  if (a > 1) {
    return 1;
  }
  return 2;
}
