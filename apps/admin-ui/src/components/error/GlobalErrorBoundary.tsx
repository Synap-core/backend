/**
 * GlobalErrorBoundary Component
 *
 * Catches React errors anywhere in the component tree and displays
 * a user-friendly error UI instead of crashing the entire app.
 */

import { Component, type ReactNode } from "react";
import {
  Container,
  Stack,
  Title,
  Text,
  Button,
  Code,
  Card,
} from "@mantine/core";
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import { colors, typography, spacing, borderRadius } from "../../theme/tokens";

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
    // Log error to console in development
    if (import.meta.env.DEV) {
      console.error("GlobalErrorBoundary caught an error:", error, errorInfo);
    }

    // In production, you could log to an error reporting service here
    // e.g., Sentry, LogRocket, etc.

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
      // Use custom fallback if provided
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default error UI
      return (
        <Container size="md" style={{ padding: spacing[8] }}>
          <Card
            padding={spacing[6]}
            radius={borderRadius.lg}
            style={{
              border: `1px solid ${colors.border.default}`,
              backgroundColor: colors.background.primary,
            }}
          >
            <Stack gap={spacing[4]}>
              <div style={{ textAlign: "center" }}>
                <IconAlertTriangle
                  size={64}
                  color={colors.semantic.error}
                  style={{ marginBottom: spacing[4] }}
                />
                <Title
                  order={2}
                  style={{
                    fontFamily: typography.fontFamily.sans,
                    color: colors.text.primary,
                    marginBottom: spacing[2],
                  }}
                >
                  Something went wrong
                </Title>
                <Text
                  size="sm"
                  style={{
                    color: colors.text.secondary,
                    fontFamily: typography.fontFamily.sans,
                  }}
                >
                  An unexpected error occurred. Please try refreshing the page.
                </Text>
              </div>

              {import.meta.env.DEV && this.state.error && (
                <div>
                  <Text
                    size="sm"
                    fw={typography.fontWeight.semibold}
                    mb={spacing[2]}
                    style={{ color: colors.text.primary }}
                  >
                    Error Details (Development Only):
                  </Text>
                  <Code
                    block
                    style={{
                      fontSize: typography.fontSize.xs,
                      maxHeight: "200px",
                      overflow: "auto",
                    }}
                  >
                    {this.state.error.toString()}
                    {this.state.errorInfo && (
                      <>
                        {"\n\n"}
                        Component Stack:
                        {"\n"}
                        {this.state.errorInfo.componentStack}
                      </>
                    )}
                  </Code>
                </div>
              )}

              <div
                style={{
                  display: "flex",
                  gap: spacing[3],
                  justifyContent: "center",
                }}
              >
                <Button
                  leftSection={<IconRefresh size={18} />}
                  onClick={this.handleReset}
                  variant="light"
                >
                  Try Again
                </Button>
                <Button
                  onClick={() => window.location.reload()}
                  variant="filled"
                >
                  Reload Page
                </Button>
              </div>
            </Stack>
          </Card>
        </Container>
      );
    }

    return this.props.children;
  }
}
