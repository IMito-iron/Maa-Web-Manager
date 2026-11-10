// Operator name resolution, ported from MaaWpfGui v6.21.4 `Helper/DataHelper.cs`
// (BuildNameIndex / GetCharacterByNameOrAlias): every entry of battle_data.json `chars` is indexed by
// its CN/EN/JP/KR/TW name, case-insensitively (StringComparer.OrdinalIgnoreCase), first entry wins
// (Dictionary.TryAdd in file order); the result is the entry's CN `name`.
const NAME_FIELDS = ['name', 'name_en', 'name_jp', 'name_kr', 'name_tw'];

/** Ordinal-ignore-case key. JS toUpperCase is a close stand-in for .NET's invariant upper-casing. */
const fold = (value: string) => value.toUpperCase();

export interface OperatorIndex {
  /** CN name for any server's name, or undefined when not in battle_data (sent as typed). */
  resolve(nameOrAlias: string): string | undefined;
  readonly size: number;
}

export function buildOperatorIndex(battleData: unknown): OperatorIndex {
  const chars = (battleData as any)?.chars;
  const map = new Map<string, string>();
  if (chars && typeof chars === 'object' && !Array.isArray(chars)) {
    for (const character of Object.values<any>(chars)) {
      const official = typeof character?.name === 'string' ? character.name : undefined;
      for (const field of NAME_FIELDS) {
        const name = character?.[field];
        if (typeof name !== 'string' || name.trim() === '') continue;
        const key = fold(name);
        // DataHelper returns the CharacterInfo; the serializer then uses its CN Name (may be null).
        if (!map.has(key)) map.set(key, official ?? '');
      }
    }
  }
  return {
    resolve: name => { const hit = map.get(fold(name)); return hit ? hit : undefined; },
    size: map.size,
  };
}
