import { describe, expect, it } from 'vitest';
import { createStreamState, feedSse } from '../src/providers/openai-compatible';

function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe('feedSse', () => {
  it('emits content deltas as they stream in', () => {
    const state = createStreamState();
    const tokens: string[] = [];
    feedSse(state, sseChunk({ choices: [{ delta: { content: 'Hello' } }] }), (t) => tokens.push(t));
    feedSse(state, sseChunk({ choices: [{ delta: { content: ' world' } }] }), (t) => tokens.push(t));
    expect(tokens.join('')).toBe('Hello world');
    expect(state.text).toBe('Hello world');
  });

  it('accumulates tool_call arguments split across chunks', () => {
    const state = createStreamState();
    const tokens: string[] = [];
    feedSse(
      state,
      sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city":' } }] } }] }),
      (t) => tokens.push(t)
    );
    feedSse(
      state,
      sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"NYC"}' } }] }, finish_reason: 'tool_calls' }] }),
      (t) => tokens.push(t)
    );
    const entry = state.toolCalls.get(0)!;
    expect(entry.name).toBe('get_weather');
    expect(JSON.parse(entry.args)).toEqual({ city: 'NYC' });
    expect(state.finishReason).toBe('tool_calls');
  });

  it('joins a multi-line data: event before parsing', () => {
    const state = createStreamState();
    const tokens: string[] = [];
    // Per SSE spec, a payload with embedded newlines is sent as one "data:" line per physical
    // line, and consecutive data: lines join with \n before the event is dispatched at the blank line.
    const pretty = JSON.stringify({ choices: [{ delta: { content: 'multi-line' } }] }, null, 2);
    const sseLines = pretty
      .split('\n')
      .map((l) => `data: ${l}`)
      .join('\n');
    feedSse(state, `${sseLines}\n\n`, (t) => tokens.push(t));
    expect(tokens.join('')).toBe('multi-line');
  });

  it('ignores [DONE]', () => {
    const state = createStreamState();
    const tokens: string[] = [];
    feedSse(state, sseChunk({ choices: [{ delta: { content: 'hi' } }] }) + 'data: [DONE]\n\n', (t) => tokens.push(t));
    expect(tokens.join('')).toBe('hi');
  });

  it('throws on an error body', () => {
    const state = createStreamState();
    expect(() => feedSse(state, 'data: {"error":{"message":"boom"}}\n\n', () => {})).toThrow(/boom/);
  });

  it('strips <think> reasoning blocks from streamed text', () => {
    const state = createStreamState();
    const tokens: string[] = [];
    feedSse(state, sseChunk({ choices: [{ delta: { content: 'before <think>secret reasoning</think> after' } }] }), (t) => tokens.push(t));
    expect(tokens.join('')).toBe('before  after');
    expect(state.text).not.toContain('secret reasoning');
  });
});
