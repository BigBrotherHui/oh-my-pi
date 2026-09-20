/** Incremental UTF-16 line index shared by retained text documents. */
export class IncrementalLineIndex {
	private readonly starts: number[] = [0];

	constructor(text: string) {
		this.reset(text);
	}

	/** Number of logical lines, including the empty line after a trailing newline. */
	get lineCount(): number {
		return this.starts.length;
	}

	/** Reset the index by scanning the complete replacement text. */
	reset(text: string): void {
		this.starts.length = 1;
		this.starts[0] = 0;
		this.scan(text, 0, 0);
	}

	/** Extend the index by scanning only appended code units. */
	append(previousLength: number, appended: string): void {
		this.scan(appended, 0, previousLength);
	}

	/** Re-index from the line touched by a replacement through the new suffix. */
	replace(previousText: string, nextText: string, start: number): void {
		const affectedLine = this.lineAtOffset(start, previousText.length);
		const affectedStart = this.starts[affectedLine]!;
		this.starts.length = affectedLine + 1;
		this.scan(nextText, affectedStart, 0);
	}

	/** Return a line without its LF or CRLF terminator. */
	line(text: string, index: number): string {
		const start = this.lineStart(index);
		let end = index + 1 < this.starts.length ? this.starts[index + 1]! : text.length;
		if (end > start && text.charCodeAt(end - 1) === 0x0a) {
			end--;
			if (end > start && text.charCodeAt(end - 1) === 0x0d) end--;
		}
		return text.slice(start, end);
	}

	/** Return the UTF-16 code-unit offset of a logical line. */
	lineStart(index: number): number {
		if (!Number.isInteger(index) || index < 0 || index >= this.starts.length) {
			throw new RangeError(`Line index ${index} is outside 0..${this.starts.length - 1}`);
		}
		return this.starts[index]!;
	}

	private lineAtOffset(offset: number, textLength: number): number {
		const bounded = Math.max(0, Math.min(offset, textLength));
		let low = 0;
		let high = this.starts.length;
		while (low + 1 < high) {
			const middle = low + ((high - low) >> 1);
			if (this.starts[middle]! <= bounded) low = middle;
			else high = middle;
		}
		return low;
	}

	private scan(text: string, from: number, base: number): void {
		for (let index = from; index < text.length; index++) {
			if (text.charCodeAt(index) === 0x0a) this.starts.push(base + index + 1);
		}
	}
}
