// lib/whip.js - SDP parsing, answer creation, codec/profile validation for WHIP ingest
'use strict';

/**
 * Parse an SDP offer string from OBS into structured media info.
 */
function parseOffer(sdpString, options = {}) {
    const lines = sdpString.replace(/\r\n/g, '\n').split('\n');
    const result = { video: null, audio: null, raw: sdpString };
    let currentMedia = null;

    // Session-level attributes (OBS puts fingerprint/ICE/setup here)
    let sessionFingerprint = null;
    let sessionSetup = null;
    let sessionIceUfrag = null;
    let sessionIcePwd = null;

    for (const line of lines) {
        // Media line: m=video 9 UDP/TLS/RTP/SAVPF 96 ...
        const mMatch = line.match(/^m=(video|audio)\s+(\d+)\s+\S+\s+(.+)/);
        if (mMatch) {
            const kind = mMatch[1];
            const payloadTypes = mMatch[3].trim().split(/\s+/).map(Number);
            currentMedia = {
                kind,
                port: parseInt(mMatch[2], 10),
                payloadTypes,
                codecs: [],
                ssrc: null,
                rtcpFb: [],
                fmtp: {},
                direction: 'sendrecv',
                iceUfrag: null,
                icePwd: null,
                fingerprint: null,
                setup: null,
                mid: null,
            };
            if (kind === 'video') result.video = currentMedia;
            else result.audio = currentMedia;
            continue;
        }

        // Parse ICE/DTLS/fingerprint at both session and media level
        const fpMatch = line.match(/^a=fingerprint:(\S+)\s+(.+)/);
        if (fpMatch) {
            const fp = { algorithm: fpMatch[1], value: fpMatch[2].trim() };
            if (currentMedia) currentMedia.fingerprint = fp;
            else sessionFingerprint = fp;
            continue;
        }
        const setupMatch = line.match(/^a=setup:(\S+)/);
        if (setupMatch) {
            const s = setupMatch[1].trim();
            if (currentMedia) currentMedia.setup = s;
            else sessionSetup = s;
            continue;
        }
        const ufragMatch = line.match(/^a=ice-ufrag:(.+)/);
        if (ufragMatch) {
            const u = ufragMatch[1].trim();
            if (currentMedia) currentMedia.iceUfrag = u;
            else sessionIceUfrag = u;
            continue;
        }
        const pwdMatch = line.match(/^a=ice-pwd:(.+)/);
        if (pwdMatch) {
            const p = pwdMatch[1].trim();
            if (currentMedia) currentMedia.icePwd = p;
            else sessionIcePwd = p;
            continue;
        }

        if (!currentMedia) continue;

        // rtpmap: a=rtpmap:96 H264/90000
        const rtpmapMatch = line.match(/^a=rtpmap:(\d+)\s+([^/\s]+)\/(\d+)(?:\/(\d+))?/);
        if (rtpmapMatch) {
            currentMedia.codecs.push({
                payloadType: parseInt(rtpmapMatch[1], 10),
                name: rtpmapMatch[2].toUpperCase(),
                clockRate: parseInt(rtpmapMatch[3], 10),
                channels: rtpmapMatch[4] ? parseInt(rtpmapMatch[4], 10) : undefined,
            });
            continue;
        }

        // fmtp: a=fmtp:96 profile-level-id=640032;level-asymmetry-allowed=1;packetization-mode=1
        const fmtpMatch = line.match(/^a=fmtp:(\d+)\s+(.+)/);
        if (fmtpMatch) {
            const pt = parseInt(fmtpMatch[1], 10);
            const params = {};
            fmtpMatch[2].split(';').forEach(pair => {
                const [k, v] = pair.trim().split('=');
                if (k) params[k.trim().toLowerCase()] = v ? v.trim() : '';
            });
            currentMedia.fmtp[pt] = params;
            continue;
        }

        // SSRC: a=ssrc:12345 cname:...
        const ssrcMatch = line.match(/^a=ssrc:(\d+)/);
        if (ssrcMatch && !currentMedia.ssrc) {
            currentMedia.ssrc = parseInt(ssrcMatch[1], 10);
            continue;
        }

        // rtcp-fb: a=rtcp-fb:96 nack
        const rtcpFbMatch = line.match(/^a=rtcp-fb:(\d+)\s+(.+)/);
        if (rtcpFbMatch) {
            currentMedia.rtcpFb.push({
                payloadType: parseInt(rtcpFbMatch[1], 10),
                type: rtcpFbMatch[2].trim(),
            });
            continue;
        }

        // Direction
        if (/^a=(sendonly|recvonly|sendrecv|inactive)/.test(line)) {
            currentMedia.direction = line.slice(2).trim();
            continue;
        }

        // MID
        const midMatch = line.match(/^a=mid:(.+)/);
        if (midMatch) { currentMedia.mid = midMatch[1].trim(); continue; }
    }

    // Inherit session-level attributes into media sections that lack them
    for (const section of [result.video, result.audio]) {
        if (!section) continue;
        if (!section.fingerprint && sessionFingerprint) section.fingerprint = sessionFingerprint;
        if (!section.setup && sessionSetup) section.setup = sessionSetup;
        if (!section.iceUfrag && sessionIceUfrag) section.iceUfrag = sessionIceUfrag;
        if (!section.icePwd && sessionIcePwd) section.icePwd = sessionIcePwd;
    }

    // Pick the best codec for each media
    if (result.video) {
        result.video.selectedCodec = selectVideoCodec(result.video, options);
    }
    if (result.audio) {
        result.audio.selectedCodec = selectAudioCodec(result.audio);
    }

    return result;
}

/**
 * Select the best H.264 video codec from the offered list.
 */
function selectVideoCodec(media, options = {}) {
    const preferAv1 = options.preferAv1 === true;
    const av1Codecs = media.codecs.filter(c => c.name === 'AV1');
    if (preferAv1 && av1Codecs.length > 0) {
        return { ...av1Codecs[0], codec: 'av1' };
    }

    const h264Codecs = media.codecs.filter(c => c.name === 'H264');
    if (h264Codecs.length === 0) return null;

    // Sort by profile: High (64) > Main (4d) > Baseline (42)
    const profileOrder = { '64': 3, '4d': 2, '42': 1 };
    let best = null;
    let bestScore = 0;
    for (const c of h264Codecs) {
        const fmtp = media.fmtp[c.payloadType] || {};
        const plid = fmtp['profile-level-id'] || '42e01f';
        const prefix = plid.substring(0, 2).toLowerCase();
        const score = profileOrder[prefix] || 0;
        if (score > bestScore || !best) {
            best = { ...c, codec: 'h264', profileLevelId: plid };
            bestScore = score;
        }
    }
    return best;
}

/**
 * Select audio codec. Only Opus is accepted.
 */
function selectAudioCodec(media) {
    const opus = media.codecs.find(c => c.name === 'OPUS');
    if (opus) return { ...opus, codec: 'opus' };
    return null;
}

function validateCodecs(parsedOffer, options = {}) {
    const warnings = [];
    const requiredVideoCodec = String(options.requiredVideoCodec || '').trim().toLowerCase();
    const allowAv1 = options.allowAv1 === true || requiredVideoCodec === 'av1';

    if (!parsedOffer.video || !parsedOffer.video.selectedCodec) {
        const missingVideoMessage = requiredVideoCodec === 'av1'
            ? 'OBS WHIP ingest for this room requires AV1 video.'
            : 'OBS WHIP ingest currently requires H.264 video.';
        return {
            valid: false,
            videoCodec: null,
            warnings: [missingVideoMessage],
        };
    }

    const vc = parsedOffer.video.selectedCodec;

    if (requiredVideoCodec && vc.codec !== requiredVideoCodec) {
        return {
            valid: false,
            videoCodec: vc.codec,
            warnings: [`OBS WHIP ingest for this room requires ${requiredVideoCodec.toUpperCase()} video.`],
        };
    }

    if (vc.codec !== 'h264' && !(allowAv1 && vc.codec === 'av1')) {
        return {
            valid: false,
            videoCodec: vc.codec,
            warnings: ['OBS WHIP ingest currently requires H.264 video.'],
        };
    }

    if (vc.codec === 'h264' && vc.profileLevelId) {
        const prefix = vc.profileLevelId.substring(0, 2).toLowerCase();
        if (prefix === '42') {
            warnings.push('H.264 Baseline profile detected. Main or High profile is recommended for better quality.');
        }
    }

    if (!parsedOffer.audio || !parsedOffer.audio.selectedCodec) {
        warnings.push('No audio track found. Room will be video-only.');
    }

    return {
        valid: vc.codec === 'h264' || (allowAv1 && vc.codec === 'av1'),
        videoCodec: vc.codec,
        warnings,
    };
}

/**
 * Convert parsed SDP offer into mediasoup RTP parameters for transport.produce().
 */
function toMediasoupRtpParameters(parsedOffer) {
    const result = { video: null, audio: null };

    if (parsedOffer.video && parsedOffer.video.selectedCodec) {
        const vc = parsedOffer.video.selectedCodec;
        const fmtp = parsedOffer.video.fmtp[vc.payloadType] || {};

        const parameters = {};
        if (vc.codec === 'h264' && vc.profileLevelId) {
            parameters['profile-level-id'] = vc.profileLevelId;
            if (fmtp['level-asymmetry-allowed']) parameters['level-asymmetry-allowed'] = Number(fmtp['level-asymmetry-allowed']);
            if (fmtp['packetization-mode']) parameters['packetization-mode'] = Number(fmtp['packetization-mode']);
        }

        const rtcpFeedback = parsedOffer.video.rtcpFb
            .filter(fb => fb.payloadType === vc.payloadType)
            .map(fb => {
                const parts = fb.type.split(/\s+/);
                return { type: parts[0], parameter: parts[1] || '' };
            });

        result.video = {
            codecs: [{
                mimeType: `video/${vc.name}`,
                clockRate: vc.clockRate,
                payloadType: vc.payloadType,
                parameters,
                rtcpFeedback,
            }],
            encodings: [{ ssrc: parsedOffer.video.ssrc }],
        };
    }

    if (parsedOffer.audio && parsedOffer.audio.selectedCodec) {
        const ac = parsedOffer.audio.selectedCodec;
        const fmtp = parsedOffer.audio.fmtp[ac.payloadType] || {};

        const parameters = {};
        if (fmtp.minptime) parameters.minptime = Number(fmtp.minptime);
        if (fmtp.useinbandfec) parameters.useinbandfec = Number(fmtp.useinbandfec);
        if (fmtp.usedtx) parameters.usedtx = Number(fmtp.usedtx);
        if (fmtp.stereo) parameters.stereo = Number(fmtp.stereo);
        if (fmtp.sprop_stereo) parameters['sprop-stereo'] = Number(fmtp.sprop_stereo);

        const rtcpFeedback = parsedOffer.audio.rtcpFb
            .filter(fb => fb.payloadType === ac.payloadType)
            .map(fb => {
                const parts = fb.type.split(/\s+/);
                return { type: parts[0], parameter: parts[1] || '' };
            });

        result.audio = {
            codecs: [{
                mimeType: 'audio/opus',
                clockRate: ac.clockRate,
                payloadType: ac.payloadType,
                channels: ac.channels || 2,
                parameters,
                rtcpFeedback,
            }],
            encodings: [{ ssrc: parsedOffer.audio.ssrc }],
        };
    }

    return result;
}

/**
 * Extract DTLS parameters from a parsed offer for use with transport.connect().
 * Returns mediasoup DtlsParameters shape.
 */
function parseDtlsParameters(parsedOffer) {
    // Use video section's fingerprint; fall back to audio
    const section = parsedOffer.video || parsedOffer.audio;
    if (!section || !section.fingerprint) return null;

    const { algorithm, value } = section.fingerprint;
    // OBS sends a=setup:actpass; server should be passive
    const role = section.setup === 'active' ? 'server' : 'client';

    return {
        role,
        fingerprints: [{ algorithm, value }],
    };
}

/**
 * Create a WebRTC SDP answer string for the WHIP response.
 *
 * @param {object} parsedOffer - result of parseOffer()
 * @param {object} transportParams - mediasoup transport params: { iceParameters, iceCandidates, dtlsParameters }
 */
function createAnswer(parsedOffer, { iceParameters, iceCandidates, dtlsParameters }) {
    const mids = [];
    if (parsedOffer.video && parsedOffer.video.selectedCodec) mids.push(parsedOffer.video.mid || '0');
    if (parsedOffer.audio && parsedOffer.audio.selectedCodec) mids.push(parsedOffer.audio.mid || '1');

    const fingerprint = dtlsParameters?.fingerprints?.[0];
    const fpLine = fingerprint
        ? `a=fingerprint:${fingerprint.algorithm} ${fingerprint.value}`
        : '';

    const lines = [
        'v=0',
        `o=- ${Date.now()} 1 IN IP4 0.0.0.0`,
        's=-',
        't=0 0',
        `a=group:BUNDLE ${mids.join(' ')}`,
        'a=msid-semantic: WMS',
    ];

    function buildMediaSection(kind, section, codec) {
        const pt = codec.payloadType;
        const mid = section.mid || (kind === 'video' ? '0' : '1');
        const sec = [
            `m=${kind} 9 UDP/TLS/RTP/SAVPF ${pt}`,
            'c=IN IP4 0.0.0.0',
            'a=rtcp:9 IN IP4 0.0.0.0',
            `a=ice-ufrag:${iceParameters.usernameFragment}`,
            `a=ice-pwd:${iceParameters.password}`,
            'a=ice-options:trickle',
        ];
        if (fpLine) sec.push(fpLine);
        sec.push('a=setup:passive');
        sec.push(`a=mid:${mid}`);
        sec.push('a=recvonly');
        sec.push('a=rtcp-mux');
        sec.push('a=rtcp-rsize');
        sec.push(`a=rtpmap:${pt} ${codec.name}/${codec.clockRate}${codec.channels ? '/' + codec.channels : ''}`);

        const fmtp = section.fmtp[pt];
        if (fmtp && Object.keys(fmtp).length > 0) {
            const fmtpStr = Object.entries(fmtp).map(([k, v]) => v ? `${k}=${v}` : k).join(';');
            sec.push(`a=fmtp:${pt} ${fmtpStr}`);
        }

        // ICE candidates
        for (const cand of (iceCandidates || [])) {
            const proto = cand.protocol || 'udp';
            const type = cand.type || 'host';
            sec.push(`a=candidate:1 1 ${proto.toUpperCase()} 2130706431 ${cand.ip} ${cand.port} typ ${type}`);
        }
        sec.push('a=end-of-candidates');

        return sec;
    }

    if (parsedOffer.video && parsedOffer.video.selectedCodec) {
        lines.push(...buildMediaSection('video', parsedOffer.video, parsedOffer.video.selectedCodec));
    }
    if (parsedOffer.audio && parsedOffer.audio.selectedCodec) {
        lines.push(...buildMediaSection('audio', parsedOffer.audio, parsedOffer.audio.selectedCodec));
    }

    lines.push('');
    return lines.join('\r\n');
}

module.exports = { parseOffer, validateCodecs, toMediasoupRtpParameters, createAnswer, parseDtlsParameters };
