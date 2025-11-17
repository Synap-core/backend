import type { BaseMessage, BaseMessageChunk } from '@langchain/core/messages';

type MessageLike = BaseMessage | BaseMessageChunk;

export function messageContentToString(message: MessageLike): string {
  return contentToString((message as any).content);
}

export function contentToString(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object' && 'text' in part && typeof (part as any).text === 'string') {
          return (part as any).text;
        }
        if (part && typeof part === 'object' && 'message' in part) {
          return contentToString((part as any).message);
        }
        return '';
      })
      .join('')
      .trim();
  }

  if (content && typeof content === 'object') {
    if ('text' in (content as any) && typeof (content as any).text === 'string') {
      return (content as any).text;
    }
    if ('message' in (content as any)) {
      return contentToString((content as any).message);
    }
  }

  if (content === null || content === undefined) {
    return '';
  }

  return String(content);
}

type TokenUsage = {
  input: number;
  output: number;
  total: number;
};

export function extractTokenUsage(metadata: any): TokenUsage {
  const usage =
    metadata?.usage ??
    metadata?.tokenUsage ??
    metadata?.token_usage ??
    metadata?.tokenCounts ??
    metadata?.token_count ??
    {};

  const input =
    usage.input_tokens ??
    usage.promptTokens ??
    usage.prompt_tokens ??
    usage.total_input_tokens ??
    usage.total_prompt_tokens ??
    0;

  const output =
    usage.output_tokens ??
    usage.completionTokens ??
    usage.completion_tokens ??
    usage.total_output_tokens ??
    0;

  const total =
    usage.total_tokens ??
    usage.total ??
    (typeof input === 'number' && typeof output === 'number' ? input + output : 0);

  return {
    input: typeof input === 'number' ? input : 0,
    output: typeof output === 'number' ? output : 0,
    total: typeof total === 'number' ? total : 0,
  };
}



