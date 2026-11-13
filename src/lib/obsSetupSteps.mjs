// The three steps the host page shows while it sets OBS up, each with its
// state. Everything is derived from what the page already knows: the
// auto-configure status, the progress configureObsStream reported for the
// current start, whether OBS has connected to the WHIP endpoint, and whether
// Nextra was asked to start the stream itself.

const STEPS = [
    { id: 'found', label: 'OBS found on this computer' },
    { id: 'settings', label: 'Nextra applies the stream settings' },
    { id: 'streaming', label: 'OBS starts streaming' },
];

// How many steps the reported progress has completed.
function completedByProgress(progress) {
    if (progress === 'configured') return 2;
    if (progress === 'connected') return 1;
    return 0;
}

/**
 * @param {object} input
 * @param {string} input.autoStatus - '' | 'configuring' | 'success' | 'error'
 * @param {string} input.progress - '' | 'connected' | 'configured'
 * @param {boolean} input.whipConnected - OBS is streaming into the room.
 * @param {boolean} input.autoStart - Nextra starts the stream in OBS itself.
 * @returns {Array<{ id: string, label: string, state: 'done'|'working'|'waiting'|'attention'|'idle', hint: string }>}
 */
export function obsSetupSteps({ autoStatus, progress, whipConnected, autoStart }) {
    let states;
    let streamingHint = '';
    if (whipConnected) {
        states = ['done', 'done', 'done'];
    } else if (autoStatus === 'success') {
        states = ['done', 'done', autoStart ? 'working' : 'waiting'];
        if (!autoStart) streamingHint = 'Press Start Streaming in OBS.';
    } else if (autoStatus === 'configuring' || autoStatus === 'error') {
        const completed = completedByProgress(progress);
        const current = autoStatus === 'error' ? 'attention' : 'working';
        states = STEPS.map((_, index) => {
            if (index < completed) return 'done';
            if (index === completed) return current;
            return 'waiting';
        });
    } else {
        states = ['idle', 'idle', 'idle'];
    }
    return STEPS.map((step, index) => ({
        ...step,
        state: states[index],
        hint: step.id === 'streaming' ? streamingHint : '',
    }));
}
