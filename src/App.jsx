import React, { lazy, Suspense, useState, useEffect } from 'react';
import { SocketProvider } from './context/SocketContext';
import './index.css';

const HostView = lazy(() => import('./HostView'));
const WatchView = lazy(() => import('./WatchView'));
const HowToView = lazy(() => import('./HowToView'));

function Router() {
    const [route, setRoute] = useState(window.location.hash || '');

    useEffect(() => {
        const onHashChange = () => setRoute(window.location.hash);
        window.addEventListener('hashchange', onHashChange);
        return () => window.removeEventListener('hashchange', onHashChange);
    }, []);

    let view;
    if (route === '#host') view = <HostView />;
    else if (route === '#how-to') view = <HowToView />;
    else if (route.startsWith('#watch')) {
        const parts = route.split('/');
        const initialCode = parts[1] || '';
        view = <WatchView initialCode={initialCode} />;
    } else {
        view = <Landing />;
    }

    return (
        <div className="app-layout">
            <header className="main-nav">
                <div className="nav-brand">
                    <a href="#" className="nav-logo" title="Home">
                        <span>Nextra</span>
                    </a>
                </div>
                <nav className="nav-links">
                    <a href="#" className={route === '' || route === '#' ? 'active' : ''}>Home</a>
                    <a href="#how-to" className={route === '#how-to' ? 'active' : ''}>How to Use</a>
                    <a href="#host" className={route === '#host' ? 'active' : ''}>Host</a>
                    <a href="#watch" className={route.startsWith('#watch') ? 'active' : ''}>Watch</a>
                </nav>
            </header>
            <main className="main-content">
                <Suspense fallback={<div className="view-container" style={{ textAlign: 'center' }}>Loading...</div>}>
                    {view}
                </Suspense>
            </main>
        </div>
    );
}

function Landing() {
    return (
        <div className="landing">
            <div className="landing-content">
                <div className="logo-section">
                    <h1 className="app-title">Nextra</h1>
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
                        End-to-end encrypted media over WebRTC/TURN. Media is not stored by Nextra.
                    </p>
                </div>
            </div>
        </div>
    );
}

export default function App() {
    return (
        <SocketProvider>
            <Router />
        </SocketProvider>
    );
}
