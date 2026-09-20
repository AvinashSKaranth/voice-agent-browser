// Pure helper: merges a streamed partial transcript with a "tail" transcript that re-covers the
// last ~600ms of the same audio, so the join doesn't duplicate the overlapping words.
// ponytail: naive word-level overlap scan (up to 6 words), not a real alignment/diff - good enough
// for a half-second seam; revisit with a proper sequence alignment if seams start reading wrong.
export function mergePartialAndTail(partial: string, tail: string): string {
  const partialWords = partial.trim().split(/\s+/).filter(Boolean);
  const tailWords = tail.trim().split(/\s+/).filter(Boolean);
  if (partialWords.length === 0) return tailWords.join(' ');
  if (tailWords.length === 0) return partialWords.join(' ');

  const normalize = (w: string) => w.toLowerCase().replace(/[^\w']/g, '');
  const maxN = Math.min(6, partialWords.length, tailWords.length);
  for (let n = maxN; n >= 1; n--) {
    const end = partialWords.slice(-n).map(normalize).join(' ');
    const start = tailWords.slice(0, n).map(normalize).join(' ');
    if (end === start) {
      return [...partialWords.slice(0, -n), ...tailWords].join(' ');
    }
  }
  return [...partialWords, ...tailWords].join(' ');
}
