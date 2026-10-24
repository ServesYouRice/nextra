// lib/whip.js - SDP parsing, answer creation, codec/profile validation for WHIP ingest
'use strict';

/**
 * Parse an SDP offer string from OBS into structured media info.
 *
 * `sections` lists every offered m-section in offer order (audio, video and
 * any other kind such as application), each with its index, kind, port, proto,
 * offered formats and mid, so the answer can mirror the offer one to one.
 * `video` and `audio` are the sections accepted for each kind: the first
 * section of that kind with a supported codec, else the first section of that
 * kind (with selectedCodec null), else null.
 */
function parseOffer(sdpString, options = {}) {
    const lines = sdpString.replace(/\r\n/g, '\n').split('\n');
    const result = { video: null, audio: null, sections: [], raw: sdpString };
    const videoSections = [];
    const audioSections = [];
    // The m-section being read (any kind) and, when it is audio or video, its media info
    let currentSection = null;
    let currentMedia = null;

    // Session-level attributes (OBS puts fingerprint/ICE/setup here)
    let sessionFingerprint = null;
    let sessionSetup = null;
    let sessionIceUfrag = null;
    let sessionIcePwd = null;

    for (const line of lines) {
        // Media line: m=<media> <port>[/<count>] <proto> <fmt> ...
        // e.g. m=video 9 UDP/TLS/RTP/SAVPF 96 ... or m=application 9 UDP/DTLS/SCTP webrtc-datachannel
        const mMatch = line.match(/^m=(\S+)\s+(\d+)(?:\/\d+)?\s+(\S+)(?:\s+(.*))?/);
        if (mMatch) {
            const kind = mMatch[1];
            const formats = (mMatch[4] || '').trim().split(/\s+/).filter(Boolean);
            const section = {
                index: result.sections.length,
                kind,
                port: parseInt(mMatch[2], 10),
                proto: mMatch[3],
                formats,
                mid: null,
            };
            if (kind === 'video' || kind === 'audio') {
                currentMedia = Object.assign(section, {
                    payloadTypes: formats.map(Number),
                    codecs: [],
                    ssrc: null,
                    rtcpFb: [],
                    fmtp: {},
                    direction: 'sendrecv',
                    iceUfrag: null,
                    icePwd: null,
                    fingerprint: null,
                    setup: null,
                });
                if (kind === 'video') videoSections.push(currentMedia);
                else audioSections.push(currentMedia);
            } else {
                // Not media this server ingests; it is only recorded so the answer can reject it
                currentMedia = null;
            }
            currentSection = section;
            result.sections.push(section);
            continue;
        }

        // MID (any m-section kind)
        const midMatch = line.match(/^a=mid:(.+)/);
        if (midMatch) {
            if (currentSection) currentSection.mid = midMatch[1].trim();
            continue;
        }

        // Attributes of an m-section that is neither audio nor video stay with it
        if (currentSection && !currentMedia) continue;

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
                const trimmed = pair.trim();
                if (!trimmed) return;
                // Split on the FIRST '=' only — values such as
                // sprop-parameter-sets carry base64 that itself contains '='.
                const eq = trimmed.indexOf('=');
                if (eq === -1) {
                    params[trimmed.toLowerCase()] = '';
                } else {
                    const k = trimmed.slice(0, eq).trim().toLowerCase();
                    if (k) params[k] = trimmed.slice(eq + 1).trim();
                }
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

        // rtcp-fb: a=rtcp-fb:96 nack pli, or a=rtcp-fb:* nack for every payload type of the
        // section (RFC 4585 §4.2). The wildcard is kept as payloadType '*'.
        const rtcpFbMatch = line.match(/^a=rtcp-fb:(\*|\d+)\s+(.+)/);
        if (rtcpFbMatch) {
            currentMedia.rtcpFb.push({
                payloadType: rtcpFbMatch[1] === '*' ? '*' : parseInt(rtcpFbMatch[1], 10),
                type: rtcpFbMatch[2].trim(),
            });
            continue;
        }

        // Direction
        if (/^a=(sendonly|recvonly|sendrecv|inactive)/.test(line)) {
            currentMedia.direction = line.slice(2).trim();
            continue;
        }
    }

    // Inherit session-level attributes into media sections that lack them
    for (const section of [...videoSections, ...audioSections]) {
        if (!section.fingerprint && sessionFingerprint) section.fingerprint = sessionFingerprint;
        if (!section.setup && sessionSetup) section.setup = sessionSetup;
        if (!section.iceUfrag && sessionIceUfrag) section.iceUfrag = sessionIceUfrag;
        if (!section.icePwd && sessionIcePwd) section.icePwd = sessionIcePwd;
    }

    // Pick the best codec for each media section, then accept the first
    // supported section of each kind; the answer rejects every other section.
    for (const section of videoSections) {
        section.selectedCodec = selectVideoCodec(section, options);
    }
    for (const section of audioSections) {
        section.selectedCodec = selectAudioCodec(section);
    }
    result.video = videoSections.find(section => section.selectedCodec) || videoSections[0] || null;
    result.audio = audioSections.find(section => section.selectedCodec) || audioSections[0] || null;

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

// Always ensure keyframe-request + nack feedback on the video producer so
// mediasoup can ask OBS for keyframes (PLI/FIR). OBS uses an effectively
// infinite GOP over WHIP and only emits keyframes on request, so without
// this the relay (and any late-joining viewer) never receives one. The
// router's H.264 codecs carry these feedback types by default, so adding
// them here is safe even if OBS's offer omitted (or wildcarded) them.
const REQUIRED_VIDEO_FEEDBACK = [
    { type: 'nack', parameter: '' },
    { type: 'nack', parameter: 'pli' },
    { type: 'ccm', parameter: 'fir' },
];

/** Split an offered feedback value such as 'nack pli' into the producer parameter shape. */
function toFeedbackEntry(value) {
    const parts = String(value).trim().split(/\s+/);
    return { type: parts[0], parameter: parts[1] || '' };
}

const feedbackKey = fb => `${fb.type}:${fb.parameter}`;

/**
 * The rtcpFeedback the producer is configured with for one accepted codec:
 * the feedback the offer lists for that payload type, plus, for video, the
 * required keyframe/nack feedback above. A '*' wildcard in the offer does not
 * add to it. This is what toMediasoupRtpParameters hands to transport.produce(),
 * and what the answer may accept (see answerRtcpFeedback).
 */
function producerRtcpFeedback(kind, media, payloadType) {
    const offered = (media.rtcpFb || [])
        .filter(fb => fb.payloadType === payloadType)
        .map(fb => toFeedbackEntry(fb.type));
    if (kind !== 'video') return offered;

    const seenFb = new Set();
    const rtcpFeedback = [];
    for (const fb of [...offered, ...REQUIRED_VIDEO_FEEDBACK]) {
        const key = feedbackKey(fb);
        if (seenFb.has(key)) continue;
        seenFb.add(key);
        rtcpFeedback.push(fb);
    }
    return rtcpFeedback;
}

/**
 * The feedback the answer accepts for one codec of an offered section: what the
 * offer lists for the payload type or with '*' (RFC 4585 §4.2), limited to what
 * the producer is configured with, so nothing is accepted that mediasoup will
 * not act on, and the forced keyframe/nack feedback is not accepted unless the
 * offer asked for it. In the producer's order, each entry once.
 */
function answerRtcpFeedback(kind, media, payloadType) {
    const offered = new Set((media.rtcpFb || [])
        .filter(fb => fb.payloadType === payloadType || fb.payloadType === '*')
        .map(fb => feedbackKey(toFeedbackEntry(fb.type))));
    const accepted = new Set();
    return producerRtcpFeedback(kind, media, payloadType).filter(fb => {
        const key = feedbackKey(fb);
        if (!offered.has(key) || accepted.has(key)) return false;
        accepted.add(key);
        return true;
    });
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

        const rtcpFeedback = producerRtcpFeedback('video', parsedOffer.video, vc.payloadType);

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
        if (fmtp['sprop-stereo']) parameters['sprop-stereo'] = Number(fmtp['sprop-stereo']);

        const rtcpFeedback = producerRtcpFeedback('audio', parsedOffer.audio, ac.payloadType);

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
 * The one decision on the DTLS roles, from the offer's a=setup (RFC 5763, RFC 4145).
 *
 * The offer's setup is read from the section that supplies the DTLS parameters
 * (video, else audio; parseOffer has already applied the session-level value).
 * - 'passive': the offerer waits for the handshake, so it is the DTLS server
 *   (remoteRole 'server') and the answer is a=setup:active.
 * - 'active', 'actpass' or absent: the offerer is, or may be made, the DTLS
 *   client (remoteRole 'client') and the answer is a=setup:passive. OBS sends
 *   actpass. An unknown value such as holdconn is treated like an absent one.
 *
 * remoteRole is what mediasoup's transport.connect() expects: the role of the
 * REMOTE endpoint. answerSetup is the a=setup of every answered m-section, the
 * opposite of that role, so the two can never both wait for the other.
 */
function dtlsRoles(parsedOffer) {
    const section = parsedOffer.video || parsedOffer.audio;
    const offeredSetup = String(section?.setup || '').toLowerCase();
    return offeredSetup === 'passive'
        ? { remoteRole: 'server', answerSetup: 'active' }
        : { remoteRole: 'client', answerSetup: 'passive' };
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
    // role is the REMOTE endpoint's DTLS role, as transport.connect() expects
    const { remoteRole: role } = dtlsRoles(parsedOffer);

    return {
        role,
        fingerprints: [{ algorithm, value }],
    };
}

/**
 * Create a WebRTC SDP answer string for the WHIP response.
 *
 * The answer has one m-section per offered m-section, in offer order
 * (RFC 3264 §6). The accepted video and audio sections are answered in full;
 * every other section (unsupported codec, a second section of a kind, or a
 * kind this server does not ingest, such as application) is rejected with
 * port 0 and a=inactive and left out of the BUNDLE group (RFC 8843).
 *
 * Each accepted section also carries a=rtcp-fb for the feedback the offer lists
 * for its codec (or with '*') that the producer is configured with
 * (see answerRtcpFeedback).
 *
 * @param {object} parsedOffer - result of parseOffer()
 * @param {object} transportParams - mediasoup transport params: { iceParameters, iceCandidates, dtlsParameters }
 */
function createAnswer(parsedOffer, { iceParameters, iceCandidates, dtlsParameters }) {
    // An offer object built without parseOffer() has no section list; answer its
    // accepted video and audio sections in that order, as before.
    const offeredSections = Array.isArray(parsedOffer.sections)
        ? parsedOffer.sections
        : [parsedOffer.video, parsedOffer.audio].filter(section => section && section.selectedCodec);
    // 'video' or 'audio' for the section accepted for that kind, otherwise null (rejected)
    const acceptedKind = (section) => {
        if (!section.selectedCodec) return null;
        if (section === parsedOffer.video) return 'video';
        if (section === parsedOffer.audio) return 'audio';
        return null;
    };
    const answerMid = (kind, section) => section.mid || (kind === 'video' ? '0' : '1');

    // BUNDLE only the accepted sections, in offer order
    const mids = [];
    for (const section of offeredSections) {
        const kind = acceptedKind(section);
        if (kind) mids.push(answerMid(kind, section));
    }

    const fingerprint = dtlsParameters?.fingerprints?.[0];
    const fpLine = fingerprint
        ? `a=fingerprint:${fingerprint.algorithm} ${fingerprint.value}`
        : '';
    // One a=setup for every answered section, from the same decision that gives
    // parseDtlsParameters its remote role.
    const { answerSetup } = dtlsRoles(parsedOffer);

    const lines = [
        'v=0',
        `o=- ${Date.now()} 1 IN IP4 0.0.0.0`,
        's=-',
        't=0 0',
    ];
    if (mids.length > 0) lines.push(`a=group:BUNDLE ${mids.join(' ')}`);
    lines.push('a=msid-semantic: WMS');

    function buildMediaSection(kind, section, codec) {
        const pt = codec.payloadType;
        const mid = answerMid(kind, section);
        const sec = [
            `m=${kind} 9 UDP/TLS/RTP/SAVPF ${pt}`,
            'c=IN IP4 0.0.0.0',
            'a=rtcp:9 IN IP4 0.0.0.0',
            `a=ice-ufrag:${iceParameters.usernameFragment}`,
            `a=ice-pwd:${iceParameters.password}`,
            'a=ice-options:trickle',
        ];
        if (fpLine) sec.push(fpLine);
        sec.push(`a=setup:${answerSetup}`);
        sec.push(`a=mid:${mid}`);
        sec.push('a=recvonly');
        sec.push('a=rtcp-mux');
        sec.push('a=rtcp-rsize');
        sec.push(`a=rtpmap:${pt} ${codec.name}/${codec.clockRate}${codec.channels ? '/' + codec.channels : ''}`);

        // Only the accepted codec's payload type is answered (never an RTX one), so
        // feedback lines can only land on it.
        for (const fb of answerRtcpFeedback(kind, section, pt)) {
            sec.push(`a=rtcp-fb:${pt} ${fb.type}${fb.parameter ? ' ' + fb.parameter : ''}`);
        }

        const fmtp = section.fmtp[pt];
        if (fmtp && Object.keys(fmtp).length > 0) {
            const fmtpStr = Object.entries(fmtp).map(([k, v]) => v ? `${k}=${v}` : k).join(';');
            sec.push(`a=fmtp:${pt} ${fmtpStr}`);
        }

        // ICE candidates
        for (const cand of (iceCandidates || [])) {
            const proto = cand.protocol || 'udp';
            const type = cand.type || 'host';
            // RFC 6544 §4.5: a TCP candidate names its tcptype (passive when the candidate gives none)
            const tcpType = proto.toLowerCase() === 'tcp' ? ` tcptype ${cand.tcpType || 'passive'}` : '';
            sec.push(`a=candidate:1 1 ${proto.toUpperCase()} 2130706431 ${cand.ip} ${cand.port} typ ${type}${tcpType}`);
        }
        sec.push('a=end-of-candidates');

        return sec;
    }

    // A rejected section: port 0, the offered proto and first offered format,
    // the offered mid, and no ICE, DTLS or candidate attributes (RFC 3264 §6,
    // RFC 8843). c= is kept because the answer has no session-level c= line.
    function buildRejectedSection(section) {
        const formats = section.formats || [];
        const sec = [
            `m=${section.kind} 0 ${section.proto} ${formats.length > 0 ? formats[0] : '0'}`,
            'c=IN IP4 0.0.0.0',
        ];
        if (section.mid) sec.push(`a=mid:${section.mid}`);
        sec.push('a=inactive');
        return sec;
    }

    for (const section of offeredSections) {
        const kind = acceptedKind(section);
        if (kind) lines.push(...buildMediaSection(kind, section, section.selectedCodec));
        else lines.push(...buildRejectedSection(section));
    }

    lines.push('');
    return lines.join('\r\n');
}

module.exports = { parseOffer, validateCodecs, toMediasoupRtpParameters, createAnswer, parseDtlsParameters };
