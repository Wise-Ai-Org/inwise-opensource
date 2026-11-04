export class InsightsResponseError extends Error {
  constructor(public readonly code: 'INSIGHTS_TRUNCATED' | 'INSIGHTS_INVALID_JSON') {
    super(code === 'INSIGHTS_TRUNCATED'
      ? 'The AI response was cut off before insights were complete. Your transcript is saved.'
      : 'The AI returned an invalid insights response. Your transcript is saved.');
    this.name = 'InsightsResponseError';
  }
}

// Retry incomplete or malformed output once without accepting partial insights.
export async function readClaudeInsights<T>(
  request: (maxTokens: number) => Promise<any>,
  parse: (text: string) => T,
): Promise<T> {
  for (const maxTokens of [4096, 8192]) {
    const data = await request(maxTokens);
    let failure: InsightsResponseError;
    if (data.stop_reason === 'max_tokens') {
      failure = new InsightsResponseError('INSIGHTS_TRUNCATED');
    } else {
      const text = (data.content || []).filter((block: any) => block.type === 'text')
        .map((block: any) => block.text).join('\n');
      try {
        const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const value = JSON.parse(stripped);
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            typeof value.summary !== 'string' || !value.summary.trim()) {
          throw new SyntaxError('Missing insights summary');
        }
        return parse(stripped);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        failure = new InsightsResponseError('INSIGHTS_INVALID_JSON');
      }
    }
    if (maxTokens === 8192) throw failure;
  }
  throw new InsightsResponseError('INSIGHTS_INVALID_JSON');
}
