import React, { lazy, Suspense, useState, useEffect, useRef } from 'react';
import { SocketProvider } from './context/SocketContext';
import BrandLogo from './components/BrandLogo';
import ErrorBoundary from './components/ErrorBoundary';
import { NotificationProvider } from './context/NotificationContext';
import { routeName, routeTitle } from './lib/routeTitle.mjs';
import { canLeaveRoute } from './lib/navigationGuard.mjs';
import { extractRoomCode, formatRoomCode, normalizeRoomCode } from './lib/roomCode.mjs';
import { getSessionStorageSafely, rememberJoinIntent } from './lib/joinIntent.mjs';
import './index.css';

const HostView = lazy(() => import('./HostView'));
const WatchView = lazy(() => import('./WatchView'));
const HowToView = lazy(() => import('./HowToView'));
const PrivacyView = lazy(() => import('./PrivacyView'));
const CopyrightView = lazy(() => import('./CopyrightView'));
const StatusView = lazy(() => import('./StatusView'));

const NAV_ITEMS = [
    { hash: '#host', label: 'Host' },
    { hash: '#watch', label: 'Watch' },
    { hash: '#how-to', label: 'How to Use' },
    { hash: '#status', label: 'Status' },
];

const LANDING_FACTS = [
    'Up to 4K at 60 fps',
    'Runs on your own machine',
    'Nextra records nothing',
];

function isNavItemActive(item, route) {
    if (item.hash === '#watch') return route.startsWith('#watch');
    return route === item.hash;
}

function Router() {
    const [route, setRoute] = useState(window.location.hash || '');
    // Counts user-initiated navigations only, so the initial load never steals
    // focus from where the browser put it.
    const [navigationCount, setNavigationCount] = useState(0);
    // The menu is open for the route it was opened on, so a route change closes
    // it without an effect.
    const [menuRoute, setMenuRoute] = useState(null);
    const menuOpen = menuRoute === route;
    const setMenuOpen = (open) => setMenuRoute(open ? route : null);
    const mainRef = useRef(null);
    const menuButtonRef = useRef(null);
    const routeRef = useRef(route);

    useEffect(() => {
        routeRef.current = route;
    }, [route]);

    useEffect(() => {
        const onHashChange = () => {
            const nextRoute = window.location.hash;
            const previousRoute = routeRef.current;
            if (nextRoute === previousRoute) return;
            if (nextRoute === '#main') {
                // '#main' is the skip link's target, not a route. Keep the
                // current view mounted, restore the address and focus <main>.
                window.history.replaceState(
                    null,
                    '',
                    previousRoute || `${window.location.pathname}${window.location.search}`,
                );
                mainRef.current?.focus({ preventScroll: true });
                return;
            }
            if (!canLeaveRoute(nextRoute)) {
                // The guard is prompting instead. Put the address bar back
                // without firing another hashchange; replaceState also keeps
                // repeatedly blocked clicks from stacking history entries.
                window.history.replaceState(
                    null,
                    '',
                    previousRoute || `${window.location.pathname}${window.location.search}`,
                );
                return;
            }
            setRoute(nextRoute);
            setNavigationCount((count) => count + 1);
        };
        window.addEventListener('hashchange', onHashChange);
        return () => window.removeEventListener('hashchange', onHashChange);
    }, []);

    useEffect(() => {
        document.title = routeTitle(route);
    }, [route]);

    useEffect(() => {
        if (!menuOpen) return undefined;
        const onKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            setMenuRoute(null);
            menuButtonRef.current?.focus();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [menuOpen]);

    useEffect(() => {
        if (navigationCount === 0) return;
        // Focusing <main> on its own scrolls it flush to the viewport top, where
        // the sticky nav then covers the first heading. Scroll the page instead.
        mainRef.current?.focus({ preventScroll: true });
        window.scrollTo(0, 0);
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
            <a
                href="#main"
                className="skip-link"
                onClick={(event) => {
                    // Move focus only: the link keeps its href for semantics, but
                    // following it would make '#main' a route and drop the view.
                    event.preventDefault();
                    mainRef.current?.focus({ preventScroll: true });
                }}
            >
                Skip to content
            </a>
            <header className="main-nav">
                <div className="nav-brand">
                    <a href="#" className="nav-logo" title="Home">
                        <BrandLogo className="brand-logo-nav" />
                    </a>
                </div>
                <button
                    type="button"
                    className="nav-menu-button"
                    aria-label="Menu"
                    aria-expanded={menuOpen}
                    aria-controls="mainNavLinks"
                    ref={menuButtonRef}
                    onClick={() => setMenuOpen(!menuOpen)}
                >
                    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                        <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
                    </svg>
                </button>
                <nav
                    className={menuOpen ? 'nav-links nav-links-open' : 'nav-links'}
                    id="mainNavLinks"
                    aria-label="Main"
                >
                    {NAV_ITEMS.map((item) => {
                        const active = isNavItemActive(item, route);
                        return (
                            <a
                                key={item.label}
                                href={item.hash || '#'}
                                className={active ? 'active' : ''}
                                aria-current={active ? 'page' : undefined}
                                onClick={() => setMenuOpen(false)}
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
    const [codeValue, setCodeValue] = useState('');
    const [codeInvalid, setCodeInvalid] = useState(false);

    const onCodeChange = (event) => {
        setCodeValue(formatRoomCode(extractRoomCode(event.target.value)));
        setCodeInvalid(false);
    };

    const onJoin = (event) => {
        event.preventDefault();
        const code = normalizeRoomCode(codeValue);
        if (code.length !== 6) {
            setCodeInvalid(true);
            return;
        }
        rememberJoinIntent(code, getSessionStorageSafely(window));
        window.location.hash = `#watch/${code}`;
    };

    return (
        <div className="landing">
            <div className="landing-grid">
                <div className="landing-copy">
                    <BrandLogo className="brand-logo-hero" />
                    <h1>Share your screen. They just open a link.</h1>
                    <p className="landing-lead">
                        Self-hosted and low-latency. Host from your browser or OBS.
                        Viewers need no install and no account.
                    </p>
                    <a href="#host" className="btn btn-primary btn-main">
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                            <rect x="2" y="3.5" width="16" height="10.5" rx="2" />
                            <path d="M7 17h6M10 14v3" />
                        </svg>
                        Share my screen
                    </a>
                    <form className="landing-join" onSubmit={onJoin} noValidate>
                        <label htmlFor="homeRoomCode">Got a room code?</label>
                        <div className="landing-join-row">
                            <input
                                id="homeRoomCode"
                                className="input-code"
                                type="text"
                                inputMode="text"
                                autoComplete="off"
                                placeholder="XXX-XXX"
                                value={codeValue}
                                onChange={onCodeChange}
                                aria-invalid={codeInvalid ? 'true' : undefined}
                                aria-describedby={codeInvalid ? 'homeRoomCodeError' : undefined}
                            />
                            <button type="submit" className="btn btn-secondary">Join</button>
                        </div>
                        {codeInvalid && (
                            <p role="alert" id="homeRoomCodeError" className="landing-join-error">
                                Enter the full 6-character room code.
                            </p>
                        )}
                    </form>
                    <ul className="landing-facts">
                        {LANDING_FACTS.map((fact) => (
                            <li key={fact}>
                                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                                    <path d="M3 8.5l3.2 3L13 4.5" />
                                </svg>
                                {fact}
                            </li>
                        ))}
                    </ul>
                </div>
                <div className="landing-preview" aria-hidden="true">
                    <div className="landing-preview-screen">
                        <span className="landing-preview-badge">LIVE</span>
                        <div className="landing-preview-window">
                            <span className="landing-preview-bar" />
                            <span className="landing-preview-line" />
                            <span className="landing-preview-line landing-preview-line-short" />
                            <span className="landing-preview-block" />
                        </div>
                        <span className="landing-preview-meta">2 watching</span>
                        <span className="landing-preview-code">VW6-349</span>
                    </div>
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
