import { generateText } from '../../lib/agentApi';
import { SaveMode, TriggerSource, type AgentProvider } from './types';

export class GenerateUseCase {
  async run(params: {
    noteId: string;
    inputText: string;
    provider: AgentProvider;
    model: string;
    signal?: AbortSignal;
    onProgress?: (nextOutputText: string) => void;
    onSources?: (sources: Array<{ title: string; url: string; snippet: string; provider: string; published_at?: string }>) => void;
    onSearchWarning?: (message: string) => void;
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
    });
  }
}
