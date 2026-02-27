const mediasoup = require('mediasoup');

(async () => {
  try {
    const worker = await mediasoup.createWorker({
      logLevel: 'warn',
      rtcMinPort: 40000,
      rtcMaxPort: 40099,
    });
    console.log('✅ Mediasoup Worker PID:', worker.pid);

    const router = await worker.createRouter({
      mediaCodecs: [
        { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
        { kind: 'video', mimeType: 'video/H264', clockRate: 90000,
          parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 } },
        { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
      ],
    });
    console.log('✅ Router created. RTP capabilities:', JSON.stringify(router.rtpCapabilities).slice(0, 100) + '...');

    worker.close();
    console.log('✅ POC passed — Mediasoup compiles and runs on this machine.');
    process.exit(0);
  } catch (err) {
    console.error('❌ POC FAILED:', err.message);
    process.exit(1);
  }
})();
