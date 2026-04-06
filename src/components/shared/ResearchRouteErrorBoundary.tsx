import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
};

type State = {
  hasError: boolean;
};

export class ResearchRouteErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

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

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full items-center justify-center p-6">
          <div className="max-w-md rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            The Research editor hit an unexpected error. Please refresh this page to continue.
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
