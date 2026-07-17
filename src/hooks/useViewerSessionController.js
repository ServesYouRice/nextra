import { useCallback } from 'react';
import { createLifecycleController } from '../lib/lifecycleController.mjs';

/** Owns playback transports, consumers, relay subscriptions, media, and queues. */
export function useViewerSessionController({ socket, refs, setPlaybackMode }) {
    const {
        activePlaybackAttemptRef,
        fmp4PlayerRef,
        relaySubscribedRef,
        relayCleanupRef,
        consumersRef,
        recvTransportRef,
        objectUrlRef,
        videoRef,
        mediaStreamRef,
        mediaSourceRef,
        sourceBufferRef,
        chunkQueueRef,
        queuedBytesRef,
        userPausedRef,
        relayUnsupportedWarnedRef,
    } = refs;

    return useCallback(() => {
        activePlaybackAttemptRef.current += 1;
        const lifecycle = createLifecycleController();
        lifecycle.own('state', () => {
            mediaSourceRef.current = null;
            sourceBufferRef.current = null;
            chunkQueueRef.current = [];
            queuedBytesRef.current = 0;
            userPausedRef.current = false;
            relayUnsupportedWarnedRef.current = false;
            setPlaybackMode('');
        });
        lifecycle.own('media-stream', () => {
            mediaStreamRef.current?.getTracks?.().forEach((track) => {
                try { track.stop(); } catch { }
            });
            mediaStreamRef.current = null;
        });
        lifecycle.own('video-element', () => {
            if (!videoRef.current) return;
            videoRef.current.src = '';
            videoRef.current.srcObject = null;
        });
        lifecycle.own('object-url', () => {
            if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
            objectUrlRef.current = null;
        });
        lifecycle.own('recv-transport', () => {
            const transport = recvTransportRef.current;
            if (transport?.id) socket.emit('close-viewer-transport', { transportId: transport.id });
            transport?.close?.();
            recvTransportRef.current = null;
        });
        lifecycle.own('consumers', () => {
            consumersRef.current.forEach((consumer) => {
                try { consumer.close(); } catch { }
            });
            consumersRef.current = [];
        });
        lifecycle.own('relay-cleanup', () => {
            relayCleanupRef.current?.();
            relayCleanupRef.current = null;
        });
        lifecycle.own('relay-subscription', () => {
            if (relaySubscribedRef.current) socket.emit('relay-consume-stop');
            relaySubscribedRef.current = false;
        });
        lifecycle.own('fmp4-player', () => {
            fmp4PlayerRef.current?.stop?.();
            fmp4PlayerRef.current = null;
        });
        lifecycle.close();
    }, [
        socket,
        setPlaybackMode,
        activePlaybackAttemptRef,
        fmp4PlayerRef,
        relaySubscribedRef,
        relayCleanupRef,
        consumersRef,
        recvTransportRef,
        objectUrlRef,
        videoRef,
        mediaStreamRef,
        mediaSourceRef,
        sourceBufferRef,
        chunkQueueRef,
        queuedBytesRef,
        userPausedRef,
        relayUnsupportedWarnedRef,
    ]);
}
