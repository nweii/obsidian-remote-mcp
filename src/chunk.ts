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
    text: pieces.map(p => p.text).join('\n'),
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

  for (const piece of pieces) {
    const cost = piece.text.length + 1;
    if (fresh > 0 && size + cost > chunkChars) {
      chunks.push(toChunk(current));
      // Carry trailing pieces worth up to overlapChars into the next chunk.
      const carried: Piece[] = [];
      let carriedSize = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const c = current[i]!.text.length + 1;
        if (carriedSize + c > overlapChars) break;
        carried.unshift(current[i]!);
        carriedSize += c;
      }
      current = carried;
      size = carriedSize;
      fresh = 0;
    }
    current.push(piece);
    size += cost;
    fresh++;
  }
  if (fresh > 0) chunks.push(toChunk(current));

  return chunks.filter(c => c.text.trim() !== '');
}
