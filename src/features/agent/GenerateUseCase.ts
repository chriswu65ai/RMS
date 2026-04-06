import {
  generateText,
  preflightGenerateIngestion,
  type StreamSource,
  type ThinkingEvent,
  type IngestionDiagnostics,
} from '../../lib/agentApi';
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
    onIngestionDiagnostics?: (diagnostics: IngestionDiagnostics) => void;
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
      onIngestionDiagnostics: params.onIngestionDiagnostics,
    });
  }

  async preflight(params: {
    noteId: string;
    inputText: string;
    provider: AgentProvider;
    model: string;
  }): Promise<{ diagnostics: IngestionDiagnostics; predicted_truncation: boolean }> {
    return preflightGenerateIngestion({
      noteId: params.noteId,
      inputText: params.inputText,
      provider: params.provider,
      model: params.model,
      triggerSource: TriggerSource.Manual,
      saveMode: SaveMode.ManualOnly,
    });
  }
}
