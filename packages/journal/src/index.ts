export interface JournalEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export class Journal {
  private readonly entries: JournalEntry[] = [];

  add(entry: JournalEntry): void {
    if (!entry.id) {
      throw new Error('JournalEntry requires an id');
    }

    this.entries.push({ ...entry });
  }

  list(): readonly JournalEntry[] {
    return [...this.entries];
  }

  filterByType(type: string): readonly JournalEntry[] {
    return this.entries.filter((entry) => entry.type === type);
  }
}
