import { AlertOctagon } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  label: string;
  children: ReactNode;
}

/** Keeps a crash in one panel from blanking the whole application; the project is untouched. */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.label}] crashed`, error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center" role="alert">
        <AlertOctagon className="size-7 text-danger" aria-hidden />
        <p className="text-[13px] font-medium text-fg">The {this.props.label} panel hit an error</p>
        <p className="max-w-sm break-words text-[11.5px] text-muted">{this.state.error.message}</p>
        <button type="button" className="mt-1 rounded-md border border-line px-3 py-1 text-[12px] text-fg hover:border-accent" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
        <p className="text-[10.5px] text-dim">Your project data was not changed.</p>
      </div>
    );
  }
}
