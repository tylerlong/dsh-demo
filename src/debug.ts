/**
 * Debug harness: start agent A DIRECTLY via ctx.subagents.start('spawn') with
 * outputSchema, and dump the full SubagentResult (stopReason, output blocks,
 * structured) to see why the child fails.
 */
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-cmdline';
import { SessionId } from '@deepseek-ai/dsh-session';

export const name = 'dsh-debug-driver';
export const inject = ['agents', 'sessions', 'subagents'];

export function apply(ctx: Context): void {
  const exit = ctx.get('appExit');
  void (async () => {
    try {
      await ctx.get('loader')?.await();
      const agents = ctx.get('agents');
      const subagents = ctx.get('subagents');
      const { agent, dispose } = await agents.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        meta: { cwd: process.cwd() },
        agentOptions: { provider: 'openrouter', model: '~deepseek/deepseek-v4-flash-latest' },
      });
      await agent.whenIdle();

      const controller = new AbortController();
      const run = await subagents.start('spawn', {
        label: 'A-generate-number',
        prompt: [
          {
            type: 'text',
            text: 'Generate one random integer between 1 and 100. Report your final number by calling the structured_output tool with {"number": <the integer>}. Do not finish with plain text — only the structured_output tool call counts.',
          },
        ],
        parent: agent,
        signal: controller.signal,
        agentOptions: { provider: 'openrouter', model: 'openai/gpt-5.6-luna' },
        outputSchema: {
          type: 'object',
          properties: { number: { type: 'integer' } },
          required: ['number'],
          additionalProperties: false,
        },
      });
      const result = await run.result;
      console.log('STOP_REASON:', result.stopReason);
      console.log('STRUCTURED:', JSON.stringify(result.structured));
      console.log('OUTPUT:', JSON.stringify(result.output));
      // Dump child session events for diagnosis
      const child = run.localAgent;
      if (child) {
        console.log('=== CHILD EVENTS ===');
        for (const event of child.session.events) {
          const data = event.data as Record<string, unknown>;
          let summary: string;
          if (event.type === 'turn/end') {
            summary = JSON.stringify(data.reason);
          } else if (event.type === 'request/header') {
            const header = data.header as { config?: unknown; system?: string; tools?: unknown[] };
            summary = `config=${JSON.stringify(header.config)} tools=${header.tools ? JSON.stringify(header.tools.map((t) => (t as { name?: string }).name)) : 'NOT-IN-EVENT'}`;
          } else if (event.type === 'assistant/message') {
            summary = JSON.stringify(
              (data.message as { content?: unknown[] })?.content?.map(
                (b) => (b as { type?: string })?.type,
              ),
            );
          } else if (event.type === 'tool/call' || event.type === 'tool/result') {
            summary = JSON.stringify(data);
          } else {
            summary = JSON.stringify(data).slice(0, 300);
          }
          console.log(`${event.seq} ${event.type}: ${summary}`);
        }
      }
      await run.dispose();
      await dispose();
      exit(0);
    } catch (error) {
      console.error('DEBUG FAIL:', error);
      exit(1);
    }
  })();
}
