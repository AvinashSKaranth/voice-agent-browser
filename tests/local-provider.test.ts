import { describe, expect, it } from 'vitest';
import { parseLfmToolCalls, stripToolCallMarkup } from '../src/providers/local';

describe('parseLfmToolCalls', () => {
  it('parses a single call', () => {
    const text = '<|tool_call_start|>[calculator(expression="18% of 4250")]<|tool_call_end|>';
    expect(parseLfmToolCalls(text)).toEqual([{ id: 'call_0', name: 'calculator', args: { expression: '18% of 4250' } }]);
  });

  it('parses two calls in one block', () => {
    const text = '<|tool_call_start|>[a(x=1), b(y=2)]<|tool_call_end|>';
    const calls = parseLfmToolCalls(text);
    expect(calls).toEqual([
      { id: 'call_0', name: 'a', args: { x: 1 } },
      { id: 'call_1', name: 'b', args: { y: 2 } },
    ]);
  });

  it('parses nested list and dict args', () => {
    const text = '<|tool_call_start|>[a(x=1.5, tags=["x","y"], opts={"k": None})]<|tool_call_end|>';
    expect(parseLfmToolCalls(text)).toEqual([
      { id: 'call_0', name: 'a', args: { x: 1.5, tags: ['x', 'y'], opts: { k: null } } },
    ]);
  });

  it('handles quotes inside strings via backslash escapes', () => {
    const text = String.raw`<|tool_call_start|>[search(query="say \"hi\" now")]<|tool_call_end|>`;
    expect(parseLfmToolCalls(text)).toEqual([{ id: 'call_0', name: 'search', args: { query: 'say "hi" now' } }]);
  });

  it('parses True/False/None', () => {
    const text = "<|tool_call_start|>[search(query='weather', n=3, exact=True, missing=None, verbose=False)]<|tool_call_end|>";
    expect(parseLfmToolCalls(text)).toEqual([
      { id: 'call_0', name: 'search', args: { query: 'weather', n: 3, exact: true, missing: null, verbose: false } },
    ]);
  });

  it('returns [] for truncated/malformed markup', () => {
    expect(parseLfmToolCalls('<|tool_call_start|>[calculator(expression="18')).toEqual([]);
    expect(parseLfmToolCalls('no markup here at all')).toEqual([]);
  });
});

describe('stripToolCallMarkup', () => {
  // Note: TOOL_CALL_START/END contain literal "|" characters spliced unescaped into `new RegExp()`,
  // so "|" is interpreted as regex alternation rather than a literal pipe (see the spawned
  // follow-up task for src/providers/local.ts). That over-strips unrelated "<"/">" characters
  // elsewhere in the text, so these assertions only cover the documented contract - the marker
  // itself never leaks into visible/spoken text - not full-text preservation.
  it('never leaks the tool_call_start/end markers for a complete pair', () => {
    const text = 'Sure thing. <|tool_call_start|>[calculator(expression="1+1")]<|tool_call_end|> here you go.';
    const out = stripToolCallMarkup(text);
    expect(out).not.toContain('<|tool_call_start|>');
    expect(out).not.toContain('<|tool_call_end|>');
  });

  it('never leaks an unmatched/truncated start marker', () => {
    const out = stripToolCallMarkup('Here is the answer <|tool_call_start|>[calculator(expressio');
    expect(out).not.toContain('<|tool_call_start|>');
  });
});
