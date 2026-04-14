/**
 * GlobalErrorBoundary — catches React errors. Uses plain HTML in the fallback
 * so a broken provider/theme does not hide the failure behind a blank screen.
 */

import { Component, type CSSProperties, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: { componentStack: string } | null;
}

const shellStyle: CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  background: "#e4e4e7",
  fontFamily:
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};

const cardStyle: CSSProperties = {
  maxWidth: 480,
  background: "#fafafa",
  border: "1px solid #d4d4d8",
  borderRadius: 12,
  padding: 24,
  textAlign: "center",
};

const btnRow: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  justifyContent: "center",
  marginTop: 16,
};

const btnStyle: CSSProperties = {
  padding: "10px 16px",
  borderRadius: 8,
  border: "1px solid #d4d4d8",
  background: "#fff",
  cursor: "pointer",
  fontSize: 14,
};

const btnPrimaryStyle: CSSProperties = {
  ...btnStyle,
  background: "#18181b",
  color: "#fafafa",
  borderColor: "#18181b",
};

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
    console.error("GlobalErrorBoundary:", error, errorInfo);
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

      const showStack = import.meta.env.DEV && this.state.error;

      return (
        <div style={shellStyle}>
          <div style={cardStyle}>
            <h1 style={{ margin: "0 0 8px", fontSize: 18 }}>
              Something went wrong
            </h1>
            <p style={{ margin: 0, fontSize: 14, color: "#52525b" }}>
              The admin UI hit an error. Try again or reload. If this is
              production, check the browser console for details.
            </p>
            {showStack && this.state.error && (
              <pre
                style={{
                  marginTop: 16,
                  padding: 12,
                  textAlign: "left",
                  fontSize: 11,
                  overflow: "auto",
                  maxHeight: 200,
                  background: "#f4f4f5",
                  borderRadius: 8,
                  color: "#3f3f46",
                }}
              >
                {this.state.error.toString()}
                {this.state.errorInfo?.componentStack ?? ""}
              </pre>
            )}
            <div style={btnRow}>
              <button type="button" style={btnStyle} onClick={this.handleReset}>
                Try again
              </button>
              <button
                type="button"
                style={btnPrimaryStyle}
                onClick={() => window.location.reload()}
              >
                Reload page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
