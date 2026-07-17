import React from 'react';

export default function FirstRunGuide({ onChoose, onDismiss }) {
    return (
        <section className="first-run-guide" aria-labelledby="firstRunTitle">
            <div>
                <h2 id="firstRunTitle">How do you want to share?</h2>
                <p>Browser capture is quickest. OBS is best for scenes, overlays, and hardware encoding.</p>
            </div>
            <div className="first-run-actions">
                <button type="button" className="btn btn-primary" onClick={() => onChoose('browser')}>Browser capture</button>
                <button type="button" className="btn btn-secondary" onClick={() => onChoose('obs')}>OBS</button>
                <a className="btn btn-outline" href="#how-to">Open How-To</a>
                <button type="button" className="btn btn-outline" onClick={onDismiss}>Dismiss</button>
            </div>
        </section>
    );
}
