import React, { lazy, Suspense, useState, useEffect, useRef } from 'react';
import { SocketProvider } from './context/SocketContext';
import BrandLogo from './components/BrandLogo';
import ErrorBoundary from './components/ErrorBoundary';
import { NotificationProvider } from './context/NotificationContext';
import { routeName, routeTitle } from './lib/routeTitle.mjs';
import './index.css';

const HostView = lazy(() => import('./HostView'));
const WatchView = lazy(() => import('./WatchView'));
const HowToView = lazy(() => import('./HowToView'));
const PrivacyView = lazy(() => import('./PrivacyView'));
const CopyrightView = lazy(() => import('./CopyrightView'));
const StatusView = lazy(() => import('./StatusView'));

const NAV_ITEMS = [
    { hash: '', label: 'Home' },
    { hash: '#how-to', label: 'How to Use' },
    { hash: '#host', label: 'Host' },
    { hash: '#watch', label: 'Watch' },
    { hash: '#status', label: 'Status' },
];

function isNavItemActive(item, route) {
    if (item.hash === '') return route === '' || route === '#';
    if (item.hash === '#watch') return route.startsWith('#watch');
    return route === item.hash;
}

function Router() {
    const [route, setRoute] = useState(window.location.hash || '');
    // Counts user-initiated navigations only, so the initial load never steals
    // focus from where the browser put it.
    const [navigationCount, setNavigationCount] = useState(0);
    const mainRef = useRef(null);

    useEffect(() => {
        const onHashChange = () => {
            setRoute(window.location.hash);
            setNavigationCount((count) => count + 1);
        };
        window.addEventListener('hashchange', onHashChange);
        return () => window.removeEventListener('hashchange', onHashChange);
    }, []);

    useEffect(() => {
        document.title = routeTitle(route);
    }, [route]);

    useEffect(() => {
        if (navigationCount === 0) return;
        mainRef.current?.focus();
    }, [navigationCount, route]);

    let view;
    if (route === '' || route === '#') view = <Landing />;
    else if (route === '#host') view = <HostView />;
    else if (route === '#how-to') view = <HowToView />;
    else if (route === '#privacy') view = <PrivacyView />;
    else if (route === '#copyright') view = <CopyrightView />;
    else if (route === '#status') view = <StatusView />;
    else if (route.startsWith('#watch')) {
        const parts = route.split('/');
        const initialCode = parts[1] || '';
        view = <WatchView key={route || '#watch'} initialCode={initialCode} />;
    } else {
        view = <NotFound route={route} />;
    }

    return (
        <div className="app-layout">
            <a href="#main" className="skip-link">Skip to content</a>
            <header className="main-nav">
                <div className="nav-brand">
                    <a href="#" className="nav-logo" title="Home">
                        <BrandLogo className="brand-logo-nav" />
                    </a>
                </div>
                <nav className="nav-links" aria-label="Main">
                    {NAV_ITEMS.map((item) => {
                        const active = isNavItemActive(item, route);
                        return (
                            <a
                                key={item.label}
                                href={item.hash || '#'}
                                className={active ? 'active' : ''}
                                aria-current={active ? 'page' : undefined}
                            >
                                {item.label}
                            </a>
                        );
                    })}
                </nav>
            </header>
            <main
                className="main-content"
                id="main"
                ref={mainRef}
                tabIndex={-1}
                aria-label={routeName(route)}
            >
                <ErrorBoundary>
                    <Suspense fallback={<LoadingState />}>
                        {view}
                    </Suspense>
                </ErrorBoundary>
            </main>
            <div className="visually-hidden" role="status" data-testid="route-announcer">
                {navigationCount === 0 ? '' : routeName(route)}
            </div>
            <footer className="site-footer">
                <div className="site-footer-inner">
                    <p className="footer-note">
                        Self-hosted streaming software. Hosts are responsible for the content they share.
                    </p>
                    <nav className="footer-links" aria-label="Legal">
                        <a href="#privacy" className={route === '#privacy' ? 'active' : ''}>Privacy</a>
                        <a href="#copyright" className={route === '#copyright' ? 'active' : ''}>Copyright / Contact</a>
                    </nav>
                </div>
            </footer>
        </div>
    );
}

function LoadingState() {
    return (
        <div className="loading-state" role="status">
            <span className="spinner" aria-hidden="true" />
            <span>Loading…</span>
        </div>
    );
}

function Landing() {
    return (
        <div className="landing">
            <div className="landing-content">
                <div className="landing-hero">
                    <BrandLogo className="brand-logo-hero" />
                    <h1>Self-hosted, low-latency screen sharing</h1>
                    <p>
                        Host from your browser or OBS, share a link or a room code,
                        and viewers watch instantly — no installs, no accounts.
                    </p>
                </div>

                <div className="card-grid">
                    <a href="#host" className="card card-host">
                        <h2>Host</h2>
                        <p>Share your screen with viewers in real-time</p>
                        <span className="card-badge">Start Sharing -&gt;</span>
                    </a>

                    <a href="#watch" className="card card-watch">
                        <h2>Watch</h2>
                        <p>Join a room and watch a live stream</p>
                        <span className="card-badge">Join Room -&gt;</span>
                    </a>
                </div>

                <div className="landing-footer">
                    <p className="footer-note">
                        Media is encrypted in transit over WebRTC/TURN. Media is not stored by Nextra.
                    </p>
                </div>
            </div>
        </div>
    );
}

function NotFound({ route }) {
    return (
        <div className="center-page">
            <h1>Page not found</h1>
            <p>The address you followed doesn&apos;t match any page in this app.</p>
            {route && <code className="center-page-code">{route}</code>}
            <div className="page-actions">
                <a href="#" className="btn btn-primary">Go Home</a>
                <a href="#watch" className="btn btn-outline">Join a Room</a>
            </div>
        </div>
    );
}

export default function App() {
    return (
        <NotificationProvider>
            <SocketProvider>
                <Router />
            </SocketProvider>
        </NotificationProvider>
    );
}
