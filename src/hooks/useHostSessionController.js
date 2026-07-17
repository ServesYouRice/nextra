import { useCallback } from 'react';
import { createLifecycleController } from '../lib/lifecycleController.mjs';

/** Owns the concrete browser/mediasoup resources for one host session. */
export function useHostSessionController({
    stopRelayRecorder,
    videoProducerRef,
    audioProducerRef,
    sendTransportRef,
    streamRef,
    videoRef,
    audioCtxRef,
    silentAudioTrackRef,
    resetState,
}) {
    return useCallback(() => {
        const lifecycle = createLifecycleController();
        lifecycle.own('state', resetState);
        lifecycle.own('silent-audio', () => { silentAudioTrackRef.current = null; });
        lifecycle.own('audio-context', () => {
            audioCtxRef.current?.close?.();
            audioCtxRef.current = null;
        });
        lifecycle.own('video-element', () => {
            if (videoRef.current) videoRef.current.srcObject = null;
        });
        lifecycle.own('capture-stream', () => {
            streamRef.current?.getTracks?.().forEach((track) => {
                try { track.stop(); } catch { }
            });
            streamRef.current = null;
        });
        lifecycle.own('send-transport', () => {
            sendTransportRef.current?.close?.();
            sendTransportRef.current = null;
        });
        lifecycle.own('audio-producer', () => {
            audioProducerRef.current?.close?.();
            audioProducerRef.current = null;
        });
        lifecycle.own('video-producer', () => {
            videoProducerRef.current?.close?.();
            videoProducerRef.current = null;
        });
        lifecycle.own('relay-recorder', stopRelayRecorder);
        lifecycle.close();
    }, [
        stopRelayRecorder,
        videoProducerRef,
        audioProducerRef,
        sendTransportRef,
        streamRef,
        videoRef,
        audioCtxRef,
        silentAudioTrackRef,
        resetState,
    ]);
}
