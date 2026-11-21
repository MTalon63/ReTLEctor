// Derived formats are rebuilt from the cached CSV on demand. Holding them in the file-backed KV
// multiplied every store rewrite by four, so they live in memory instead.
const store = new Map<string, string>();
const MAX_CHARS = 64 * 1024 * 1024;

let held = 0;

export function getDerived(key: string): string | undefined {
	const value = store.get(key);
	if (value === undefined) return undefined;

	store.delete(key);
	store.set(key, value);

	return value;
}

export function setDerived(key: string, value: string): void {
	const existing = store.get(key);
	if (existing !== undefined) {
		held -= existing.length;
		store.delete(key);
	}

	store.set(key, value);
	held += value.length;

	while (held > MAX_CHARS && store.size > 1) {
		const oldest = store.keys().next().value as string;
		const dropped = store.get(oldest);

		store.delete(oldest);
		held -= dropped?.length ?? 0;
	}
}

export function clearDerived(): void {
	store.clear();
	held = 0;
}

export function derivedChars(): number {
	return held;
}
