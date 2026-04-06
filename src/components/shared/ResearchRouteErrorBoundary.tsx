import { Component, type ErrorInfo, type ReactNode } from 'react';
import { clearedResearchRouteBoundaryState, shouldResetResearchRouteBoundary } from './researchRouteErrorBoundaryState';

type Props = {
  children: ReactNode;
  resetKey?: string;
};

type State = {
  hasError: boolean;
};

export class ResearchRouteErrorBoundary extends Component<Props, State> {
  state: State = clearedResearchRouteBoundaryState();

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    console.error('Research route error boundary caught an exception', {
      phase: 'research_route_render',
      error,
      componentStack: errorInfo.componentStack,
    });
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.hasError && shouldResetResearchRouteBoundary(prevProps.resetKey, this.props.resetKey)) {
      this.setState(clearedResearchRouteBoundaryState());
    }
  }

  private onRetry = () => {
    this.setState(clearedResearchRouteBoundaryState());
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full items-center justify-center p-6">
          <div className="max-w-md rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <p>The Research editor hit an unexpected error.</p>
            <button
              type="button"
              className="mt-3 rounded border border-amber-400 bg-white px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100"
              onClick={this.onRetry}
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
