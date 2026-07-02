import React from 'react';

export default class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { error: null };
    }

    static getDerivedStateFromError(error) {
        return { error };
    }

    componentDidCatch(error, info) {
        console.error('[Nextra] Render error:', error, info?.componentStack || '');
    }

    render() {
        if (this.state.error) {
            return (
                <div className="center-page" role="alert">
                    <h1>Something went wrong</h1>
                    <p>
                        The page hit an unexpected error. Reloading usually fixes it.
                        If it keeps happening, please report it to the project maintainer.
                    </p>
                    <code className="center-page-code">
                        {String(this.state.error?.message || this.state.error)}
                    </code>
                    <div className="page-actions">
                        <button className="btn btn-primary" onClick={() => window.location.reload()}>
                            Reload App
                        </button>
                    </div>
                </div>
            );
        }
        return this.props.children;
    }
}
