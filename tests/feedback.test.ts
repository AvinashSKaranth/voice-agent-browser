import { describe, expect, it } from 'vitest';
import { pickAck } from '../src/core/feedback';

describe('pickAck', () => {
  it('picks the search ack for search/look up/find phrasing', () => {
    expect(pickAck('search for cats')).toBe('Let me search for that');
    expect(pickAck('can you look up the weather')).toBe('Let me search for that');
  });

  it('picks the action ack for open/run/create phrasing', () => {
    expect(pickAck('open the terminal')).toBe('On it');
    expect(pickAck('create a new file')).toBe('On it');
  });

  it('picks the read ack for read/summarise/describe phrasing', () => {
    expect(pickAck('summarize this document')).toBe('Let me look at that');
    expect(pickAck('describe this image')).toBe('Let me look at that');
  });

  it('picks the calculate ack for calculate/how much/convert phrasing', () => {
    expect(pickAck('calculate 2 plus 2')).toBe('Let me work that out');
    expect(pickAck('convert 5 km to miles')).toBe('Let me work that out');
  });

  it('rotates through the default acks for unmatched input', () => {
    const DEFAULT_ACKS = ['On it', 'One moment', 'Working on it', 'Sure, one second'];
    // Prime the rotation with a few calls, then confirm the next four are the full, in-order cycle.
    pickAck('xyzzy');
    const seq = [pickAck('xyzzy'), pickAck('xyzzy'), pickAck('xyzzy'), pickAck('xyzzy')];
    const startIdx = DEFAULT_ACKS.indexOf(seq[0]);
    const expected = [0, 1, 2, 3].map((i) => DEFAULT_ACKS[(startIdx + i) % DEFAULT_ACKS.length]);
    expect(seq).toEqual(expected);
  });
});
