import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            width: "100vw",
            backgroundColor: "#09090b",
            color: "#a1a1aa",
            fontFamily: "monospace",
            padding: "2rem",
          }}
        >
          <h1
            style={{
              fontSize: "1.25rem",
              marginBottom: "1rem",
              color: "#f87171",
            }}
          >
            Something went wrong
          </h1>
          <pre
            style={{
              backgroundColor: "#18181b",
              padding: "1rem",
              borderRadius: "0.5rem",
              maxWidth: "80vw",
              overflow: "auto",
              fontSize: "0.75rem",
              color: "#a1a1aa",
              border: "1px solid #27272a",
            }}
          >
            {this.state.error?.message}
          </pre>
          <button
            onClick={() => {
              this.setState({ hasError: false, error: null });
            }}
            style={{
              marginTop: "1rem",
              padding: "0.5rem 1rem",
              backgroundColor: "#27272a",
              color: "#e4e4e7",
              border: "1px solid #3f3f46",
              borderRadius: "0.375rem",
              cursor: "pointer",
            }}
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
