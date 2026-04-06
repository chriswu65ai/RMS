import { generateText, type StreamSource, type ThinkingEvent } from '../../lib/agentApi';
import { SaveMode, TriggerSource, type AgentProvider } from './types';

export class GenerateUseCase {
  async run(params: {
    noteId: string;
    inputText: string;
    provider: AgentProvider;
    model: string;
    signal?: AbortSignal;
    onProgress?: (nextOutputText: string) => void;
    onSources?: (sources: StreamSource[]) => void;
    onSearchWarning?: (message: string) => void;
    onThinkingEvent?: (event: ThinkingEvent) => void;
  }): Promise<{ outputText: string }> {
    return generateText({
      noteId: params.noteId,
      inputText: params.inputText,
      provider: params.provider,
      model: params.model,
      triggerSource: TriggerSource.Manual,
      saveMode: SaveMode.ManualOnly,
      signal: params.signal,
      onProgress: params.onProgress,
      onSources: params.onSources,
      onSearchWarning: params.onSearchWarning,
      onThinkingEvent: params.onThinkingEvent,
    });
  }
}
