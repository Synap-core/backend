/**
 * GlobalErrorBoundary — catches React errors and shows a calm recovery UI.
 */

import { Component, type ReactNode } from "react";
import { Button } from "@heroui/react";
import { Card } from "@heroui/react";
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: { componentStack: string } | null;
}

export default class GlobalErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: { componentStack: string }) {
    if (import.meta.env.DEV) {
      console.error("GlobalErrorBoundary caught an error:", error, errorInfo);
    }
    this.setState({
      error,
      errorInfo,
    });
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex min-h-screen items-center justify-center bg-[var(--pod-surface-2)] p-8">
          <Card.Root className="max-w-lg border border-divider shadow-sm">
            <Card.Header className="flex flex-col items-center gap-2 text-center">
              <IconAlertTriangle
                className="text-danger"
                size={48}
                stroke={1.5}
              />
              <Card.Title className="text-xl">Something went wrong</Card.Title>
              <Card.Description>
                An unexpected error occurred. Try again or reload the page.
              </Card.Description>
            </Card.Header>
            <Card.Content className="flex flex-col gap-4">
              {import.meta.env.DEV && this.state.error && (
                <pre className="max-h-48 overflow-auto rounded-medium bg-default-100 p-3 text-left font-mono text-xs text-default-700">
                  {this.state.error.toString()}
                  {this.state.errorInfo && (
                    <>
                      {"\n\n"}
                      Component Stack:
                      {"\n"}
                      {this.state.errorInfo.componentStack}
                    </>
                  )}
                </pre>
              )}
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="outline" onPress={this.handleReset}>
                  <span className="inline-flex items-center gap-2">
                    <IconRefresh size={18} />
                    Try again
                  </span>
                </Button>
                <Button
                  variant="primary"
                  onPress={() => window.location.reload()}
                >
                  Reload page
                </Button>
              </div>
            </Card.Content>
          </Card.Root>
        </div>
      );
    }

    return this.props.children;
  }
}
