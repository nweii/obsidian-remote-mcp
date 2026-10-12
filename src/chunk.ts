// ABOUTME: Line-aware text chunker for vault_skim. Splits a note into ~fixed-size chunks that remember
// their 1-based line range, repeating a slice of each chunk's tail at the start of the next.

export interface Chunk {
  startLine: number; // 1-based, inclusive
  endLine: number;   // 1-based, inclusive
  text: string;
}

export interface ChunkOptions {
  chunkChars?: number; // target chunk size in characters (default 2000)
  overlap?: number;    // fraction of a chunk repeated in the next one, 0–0.5 (default 0.1)
}

export const DEFAULT_CHUNK_CHARS = 2000;
export const DEFAULT_OVERLAP = 0.1;

interface Piece {
  line: number;
  text: string;
}

// A line longer than a whole chunk is cut into chunk-sized pieces that share its line number, so
// one huge line (a pasted blob, a minified table) can't produce an oversized chunk.
function toPieces(text: string, chunkChars: number): Piece[] {
  const pieces: Piece[] = [];
  text.split('\n').forEach((line, index) => {
    if (line.length <= chunkChars) {
      pieces.push({ line: index + 1, text: line });
      return;
    }
    for (let start = 0; start < line.length; start += chunkChars) {
      pieces.push({ line: index + 1, text: line.slice(start, start + chunkChars) });
    }
  });
  return pieces;
}

function toChunk(pieces: Piece[]): Chunk {
  return {
    startLine: pieces[0]!.line,
    endLine: pieces[pieces.length - 1]!.line,
    // Fragments of the same source line remain adjacent, without an invented newline.
    text: pieces.map((p, i) => `${i > 0 && pieces[i - 1]!.line !== p.line ? '\n' : ''}${p.text}`).join(''),
  };
}

export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const chunkChars = Math.max(200, options.chunkChars ?? DEFAULT_CHUNK_CHARS);
  const overlap = Math.min(0.5, Math.max(0, options.overlap ?? DEFAULT_OVERLAP));
  const overlapChars = Math.floor(chunkChars * overlap);

  const pieces = toPieces(text, chunkChars);
  if (pieces.every(p => p.text.trim() === '')) return [];

  const chunks: Chunk[] = [];
  let current: Piece[] = [];
  let size = 0;
  let fresh = 0; // pieces in `current` not carried over from the previous chunk

  function emitChunk(): void {
    chunks.push(toChunk(current));
    // Carry trailing pieces worth up to overlapChars into the next chunk.
    // A piece can contribute just its suffix, so long paragraphs retain boundary context too.
    const carried: Piece[] = [];
    let carriedSize = 0;
    for (let i = current.length - 1; i >= 0; i--) {
      const piece = current[i]!;
      const separator = carried.length > 0 && carried[0]!.line !== piece.line ? 1 : 0;
      const available = overlapChars - carriedSize - separator;
      if (available <= 0) break;
      const tail = piece.text.slice(-available);
      carried.unshift({ line: piece.line, text: tail });
      carriedSize += tail.length + separator;
      if (tail.length < piece.text.length) break;
    }
    current = carried;
    size = carriedSize;
    fresh = 0;
  }

  for (const piece of pieces) {
    let rest = piece.text;
    do {
      let separator = current.length > 0 && current.at(-1)!.line !== piece.line ? 1 : 0;
      if (fresh > 0 && size + separator + rest.length > chunkChars) {
        emitChunk();
        separator = current.length > 0 && current.at(-1)!.line !== piece.line ? 1 : 0;
      }
      // An oversized line must also fit beside the carried overlap, rather than enlarging a chunk.
      const part = rest.slice(0, chunkChars - size - separator);
      current.push({ line: piece.line, text: part });
      size += separator + part.length;
      fresh++;
      rest = rest.slice(part.length);
    } while (rest.length > 0);
  }
  if (fresh > 0) chunks.push(toChunk(current));

  return chunks.filter(c => c.text.trim() !== '');
}
