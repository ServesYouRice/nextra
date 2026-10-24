// lib/whep.js - SDP parsing and answer creation for WHEP (viewer) sessions
'use strict';

/**
 * Parse a viewer's SDP offer string into structured media info.
 * Similar to whip.js parseOffer() but adapted for viewer offers (recvonly direction)
 * and includes extmap + ICE candidate parsing.
 */
function parseViewerOffer(sdpString) {
    const lines = sdpString.replace(/\r\n/g, '\n').split('\n');
    const result = { video: null, audio: null, raw: sdpString };

    // Collect media sections in order for later use
    const mediaSections = [];
    let currentMedia = null;

    // Session-level attributes
    let sessionFingerprint = null;
    let sessionSetup = null;
    let sessionIceUfrag = null;
    let sessionIcePwd = null;

    // ICE candidates collected across the whole offer
    const iceCandidates = [];

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
                extmap: [],
            };
            mediaSections.push(currentMedia);
            if (kind === 'video' && !result.video) result.video = currentMedia;
            else if (kind === 'audio' && !result.audio) result.audio = currentMedia;
            continue;
        }

        // Fingerprint
        const fpMatch = line.match(/^a=fingerprint:(\S+)\s+(.+)/);
        if (fpMatch) {
            const fp = { algorithm: fpMatch[1], value: fpMatch[2].trim() };
            if (currentMedia) currentMedia.fingerprint = fp;
            else sessionFingerprint = fp;
            continue;
        }

        // Setup
        const setupMatch = line.match(/^a=setup:(\S+)/);
        if (setupMatch) {
            const s = setupMatch[1].trim();
            if (currentMedia) currentMedia.setup = s;
            else sessionSetup = s;
            continue;
        }

        // ICE ufrag
        const ufragMatch = line.match(/^a=ice-ufrag:(.+)/);
        if (ufragMatch) {
            const u = ufragMatch[1].trim();
            if (currentMedia) currentMedia.iceUfrag = u;
            else sessionIceUfrag = u;
            continue;
        }

        // ICE pwd
        const pwdMatch = line.match(/^a=ice-pwd:(.+)/);
        if (pwdMatch) {
            const p = pwdMatch[1].trim();
            if (currentMedia) currentMedia.icePwd = p;
            else sessionIcePwd = p;
            continue;
        }

        // ICE candidate (can appear at session or media level)
        const candMatch = line.match(/^a=candidate:(.+)/);
        if (candMatch) {
            iceCandidates.push(candMatch[1].trim());
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

        // fmtp: a=fmtp:96 profile-level-id=640032;...
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

        // rtcp-fb: a=rtcp-fb:96 nack, or a=rtcp-fb:* nack for every payload type
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

        // MID
        const midMatch = line.match(/^a=mid:(.+)/);
        if (midMatch) {
            currentMedia.mid = midMatch[1].trim();
            continue;
        }

        // extmap: a=extmap:1 urn:ietf:params:rtp-hdrext:...
        const extmapMatch = line.match(/^a=extmap:(\d+)(?:\/\S+)?\s+(\S+)/);
        if (extmapMatch) {
            currentMedia.extmap.push({
                id: parseInt(extmapMatch[1], 10),
                uri: extmapMatch[2],
            });
            continue;
        }
    }

    // Inherit session-level attributes into media sections that lack them
    for (const section of mediaSections) {
        if (!section.fingerprint && sessionFingerprint) section.fingerprint = sessionFingerprint;
        if (!section.setup && sessionSetup) section.setup = sessionSetup;
        if (!section.iceUfrag && sessionIceUfrag) section.iceUfrag = sessionIceUfrag;
        if (!section.icePwd && sessionIcePwd) section.icePwd = sessionIcePwd;
    }

    // Attach ordered media sections and ICE candidates to the result
    result._mediaSections = mediaSections;
    result._iceCandidates = iceCandidates;

    return result;
}

/**
 * The DTLS roles a viewer offer leads to (RFC 4145 section 4.1, RFC 5763 section 5),
 * read from the section parseViewerDtls takes the fingerprint from (video, else
 * audio). remoteRole is the viewer's role, as transport.connect() expects it;
 * answerSetup is the a=setup value the answer must carry, the server's own role.
 * Viewer offers passive -> viewer is DTLS server, mediasoup connects as client -> answer active.
 * Viewer offers actpass, active, or no setup -> viewer is DTLS client -> answer passive.
 */
function viewerDtlsRoles(parsedOffer) {
    const section = parsedOffer.video || parsedOffer.audio;
    const offeredSetup = String(section?.setup || '').toLowerCase();
    return offeredSetup === 'passive'
        ? { remoteRole: 'server', answerSetup: 'active' }
        : { remoteRole: 'client', answerSetup: 'passive' };
}

/**
 * Extract DTLS parameters from a parsed viewer offer.
 * For WHEP the server is the media sender; when the viewer offers actpass,
 * the server takes DTLS role 'server' (answers a=setup:passive). When the viewer
 * offers passive, the server is the DTLS client and answers a=setup:active.
 */
function parseViewerDtls(parsedOffer) {
    const section = parsedOffer.video || parsedOffer.audio;
    if (!section || !section.fingerprint) return null;

    const { algorithm, value } = section.fingerprint;

    // The role here is the REMOTE peer's DTLS role as passed to mediasoup.
    const { remoteRole: role } = viewerDtlsRoles(parsedOffer);

    return {
        role,
        fingerprints: [{ algorithm, value }],
    };
}

/**
 * Create an SDP answer for a WHEP viewer from mediasoup consumers.
 *
 * @param {object} parsedOffer - result of parseViewerOffer()
 * @param {Array} consumers - array of mediasoup Consumer objects
 * @param {object} transportParams - { iceParameters, iceCandidates, dtlsParameters }
 */
function createViewerAnswer(parsedOffer, consumers, transportParams) {
    const { iceParameters, iceCandidates, dtlsParameters } = transportParams;

    const fingerprint = dtlsParameters?.fingerprints?.[0];
    const fpLine = fingerprint
        ? `a=fingerprint:${fingerprint.algorithm} ${fingerprint.value}`
        : '';
    // One DTLS association for the bundle: every answered section says the
    // role the server takes in transport.connect() (see viewerDtlsRoles).
    const { answerSetup } = viewerDtlsRoles(parsedOffer);

    // Build a map of consumers by kind for quick lookup
    const consumersByKind = {};
    for (const consumer of consumers) {
        // First consumer of each kind wins (in case of duplicates)
        if (!consumersByKind[consumer.kind]) {
            consumersByKind[consumer.kind] = consumer;
        }
    }

    // Iterate offer m-sections in original order
    const mediaSections = parsedOffer._mediaSections || [];
    const activeMids = [];
    const sectionLines = [];

    for (const section of mediaSections) {
        // Only a section the viewer can receive on may take a consumer. A disabled
        // (port 0) or inactive/sendonly section is answered as rejected in place and
        // leaves the consumer for the first eligible section of the same kind.
        const consumer = isOfferSectionEligible(section) ? consumersByKind[section.kind] : undefined;

        if (!consumer) {
            // Reject this m-section; echo the offered mid only (RFC 8843)
            sectionLines.push(buildRejectedSection(section.kind, section.mid));
            continue;
        }

        const mid = section.mid || (section.kind === 'video' ? '0' : '1');

        // Remove from map so each consumer is used once
        delete consumersByKind[section.kind];
        activeMids.push(mid);
        sectionLines.push(buildActiveSection(
            section, mid, consumer, iceParameters, iceCandidates, fpLine, answerSetup
        ));
    }

    // Session-level lines
    const sessionLines = [
        'v=0',
        `o=- ${Date.now()} 1 IN IP4 0.0.0.0`,
        's=-',
        't=0 0',
    ];
    if (activeMids.length > 0) {
        sessionLines.push(`a=group:BUNDLE ${activeMids.join(' ')}`);
    }
    sessionLines.push('a=msid-semantic: WMS');

    // Combine
    const allLines = sessionLines.concat(...sectionLines);
    allLines.push('');
    return allLines.join('\r\n');
}

/**
 * Whether an offer m-section can receive media from the server: it is not
 * disabled (port 0) and its direction is recvonly or sendrecv. A section with
 * no direction attribute counts as sendrecv (the parser defaults to it).
 */
function isOfferSectionEligible(section) {
    if (!section || section.port === 0) return false;
    const direction = section.direction || 'sendrecv';
    return direction === 'recvonly' || direction === 'sendrecv';
}

/**
 * Build lines for a rejected m-section (port 0). The mid is echoed only when
 * the offer had one; the caller keeps it out of the BUNDLE group.
 */
function buildRejectedSection(kind, mid) {
    const lines = [
        `m=${kind} 0 UDP/TLS/RTP/SAVPF 0`,
        'c=IN IP4 0.0.0.0',
    ];
    if (mid) lines.push(`a=mid:${mid}`);
    lines.push('a=inactive');
    return lines;
}

// What an absent or empty profile-level-id means: Constrained Baseline, level 3.1.
// libwebrtc and mediasoup's h264-profile-level-id both use it (the RFC 6184 default,
// 42000a, would be plain Baseline, a different profile), and mediasoup applies it in
// consume(), so WHEP admits exactly what mediasoup will consume.
const DEFAULT_H264_PROFILE_LEVEL_ID = '42e01f';

// Bit pattern over a profile-iop byte, written as in RFC 6184: '1' and '0' must match,
// 'x' is free.
function compileBitPattern(pattern) {
    let mask = 0;
    let value = 0;
    for (let i = 0; i < 8; i += 1) {
        const bit = 0x80 >> i;
        if (pattern[i] !== 'x') mask |= bit;
        if (pattern[i] === '1') value |= bit;
    }
    return { mask, value };
}

// profile_idc, profile-iop pattern, profile: the table of libwebrtc and mediasoup
// (RFC 6184 section 8.1). Constrained Baseline is listed before Baseline, as there.
// Predictive High 4:4:4 (0xf4) is left out: none of the router's profiles is that one.
const H264_PROFILE_PATTERNS = [
    [0x42, 'x1xx0000', 'ConstrainedBaseline'],
    [0x4d, '1xxx0000', 'ConstrainedBaseline'],
    [0x58, '11xx0000', 'ConstrainedBaseline'],
    [0x42, 'x0xx0000', 'Baseline'],
    [0x58, '10xx0000', 'Baseline'],
    [0x4d, '0x0x0000', 'Main'],
    [0x64, '00000000', 'High'],
    [0x64, '00001100', 'ConstrainedHigh'],
].map(([profileIdc, pattern, profile]) => ({ profileIdc, ...compileBitPattern(pattern), profile }));

// level_idc values (level times ten) mediasoup's parser knows. Any other level makes
// mediasoup reject the codec, so it does not parse here either.
const H264_LEVEL_IDCS = new Set([10, 11, 12, 13, 20, 21, 22, 30, 31, 32, 40, 41, 42, 50, 51, 52]);
const H264_CONSTRAINT_SET3_FLAG = 0x10;

/**
 * Parse an H.264 profile-level-id (three hex bytes: profile_idc, profile-iop, level_idc)
 * into { profile, level }, or null when it is not a profile this server can compare.
 * undefined and '' mean the default 42e01f. The profile comes from profile_idc together
 * with the profile-iop constraint bits, never from profile_idc alone. level is level_idc,
 * or 0 for level 1b.
 */
function parseH264ProfileLevelId(value) {
    const text = value === undefined || value === '' ? DEFAULT_H264_PROFILE_LEVEL_ID : value;
    if (typeof text !== 'string' || !/^[0-9a-f]{6}$/i.test(text)) return null;

    const numeric = parseInt(text, 16);
    const levelIdc = numeric & 0xff;
    const profileIop = (numeric >> 8) & 0xff;
    const profileIdc = (numeric >> 16) & 0xff;
    if (!H264_LEVEL_IDCS.has(levelIdc)) return null;

    // Level 1.1 with constraint_set3 set is level 1b for the three baseline-family profile_idcs.
    const isLevel1b = levelIdc === 11 && (profileIop & H264_CONSTRAINT_SET3_FLAG) !== 0;
    for (const entry of H264_PROFILE_PATTERNS) {
        if (entry.profileIdc === profileIdc && (profileIop & entry.mask) === entry.value) {
            return { profile: entry.profile, level: isLevel1b ? 0 : levelIdc };
        }
    }
    return null;
}

/**
 * Whether two sets of H.264 fmtp parameters name the same profile. The level is not
 * compared (mediasoup handles level asymmetry itself). Both must parse, so an
 * unparseable profile-level-id never matches; an absent one is the default 42e01f.
 */
function isSameH264Profile(paramsA, paramsB) {
    const a = parseH264ProfileLevelId(paramsA?.['profile-level-id']);
    const b = parseH264ProfileLevelId(paramsB?.['profile-level-id']);
    return a !== null && b !== null && a.profile === b.profile;
}

function h264PacketizationMode(params) {
    return String(params?.['packetization-mode'] ?? '0');
}

/**
 * Whether two sets of H.264 fmtp parameters can be negotiated: the same profile
 * (isSameH264Profile) and the same packetization-mode (absent means 0). This is the
 * one H.264 comparison both WHEP matchers use.
 */
function isH264Compatible(paramsA, paramsB) {
    return isSameH264Profile(paramsA, paramsB)
        && h264PacketizationMode(paramsA) === h264PacketizationMode(paramsB);
}

/**
 * The H.264 parameters of a capability entry for one viewer codec: its own
 * profile-level-id (42e01f when it lists none), packetization-mode and
 * level-asymmetry-allowed, so mediasoup's strict match sees what the viewer offered
 * and not the router's values. Numbers where mediasoup compares with !==: the
 * producer's parameters hold packetization-mode as a number. Any other parameter of
 * the router codec is kept.
 */
function buildViewerH264Parameters(routerCodec, viewerFmtp) {
    const parameters = { ...routerCodec.parameters };
    delete parameters['profile-level-id'];
    delete parameters['packetization-mode'];
    delete parameters['level-asymmetry-allowed'];

    const profileLevelId = viewerFmtp['profile-level-id'];
    parameters['profile-level-id'] = profileLevelId ? profileLevelId.toLowerCase() : DEFAULT_H264_PROFILE_LEVEL_ID;
    const mode = h264PacketizationMode(viewerFmtp);
    parameters['packetization-mode'] = Number.isFinite(Number(mode)) ? Number(mode) : mode;

    const levelAsymmetryAllowed = viewerFmtp['level-asymmetry-allowed'];
    if (levelAsymmetryAllowed !== undefined && levelAsymmetryAllowed !== '' && Number.isFinite(Number(levelAsymmetryAllowed))) {
        parameters['level-asymmetry-allowed'] = Number(levelAsymmetryAllowed);
    }
    return parameters;
}

/**
 * Find the offer codec that matches a consumer codec by name and clock rate.
 * Returns the offer's payload type, or null if no match. ptMap maps the consumer's
 * media payload types to the offer payload types they matched, for the RTX apt check.
 */
function findOfferPt(offerSection, consumerCodec, ptMap) {
    const codecName = (consumerCodec.mimeType || '').split('/')[1]?.toUpperCase();
    if (!codecName) return null;

    for (const offerCodec of (offerSection.codecs || [])) {
        if (offerCodec.name === codecName && offerCodec.clockRate === consumerCodec.clockRate) {
            // For audio, also check channel count if present
            if (consumerCodec.channels && offerCodec.channels
                && consumerCodec.channels !== offerCodec.channels) continue;

            // For RTX, check apt (associated payload type)
            if (codecName === 'RTX') {
                const consumerApt = consumerCodec.parameters?.apt;
                const mappedApt = ptMap ? ptMap.get(consumerApt) : null;
                const offerApt = offerSection.fmtp[offerCodec.payloadType]?.apt;
                
                if (offerApt && mappedApt && parseInt(offerApt, 10) === mappedApt) {
                    return offerCodec.payloadType;
                }
                continue; // This RTX doesn't match our remapped apt
            }

            // For H264, the parsed profile (not just profile_idc) and the packetization-mode
            // must match; an absent profile-level-id is 42e01f, never a wildcard.
            if (codecName === 'H264') {
                const offerFmtp = offerSection.fmtp[offerCodec.payloadType] || {};
                if (!isH264Compatible(consumerCodec.parameters, offerFmtp)) continue;
            }

            return offerCodec.payloadType;
        }
    }
    return null;
}

/**
 * The text an RTCP feedback entry has in SDP after the payload type ("nack",
 * "nack pli", "transport-cc"), lower-cased for comparison. Takes a consumer
 * rtcpFeedback entry ({ type, parameter }) or the text of an offered a=rtcp-fb line.
 */
function feedbackText(feedback) {
    const text = typeof feedback === 'string'
        ? feedback
        : (feedback.parameter ? `${feedback.type} ${feedback.parameter}` : feedback.type);
    return String(text).trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The RTCP feedback an offer section lists for one payload type, plus the feedback
 * it lists for every payload type (a=rtcp-fb:*). A null payload type, one the offer
 * does not carry, gets the wildcard feedback only.
 */
function getOfferedFeedback(offerSection, payloadType) {
    const offered = new Set();
    for (const fb of (offerSection.rtcpFb || [])) {
        if (fb.payloadType === '*' || (payloadType != null && fb.payloadType === payloadType)) {
            offered.add(feedbackText(fb.type));
        }
    }
    return offered;
}

/**
 * Whether the offer section lists this header extension with this very id.
 */
function isExtensionOffered(offerSection, ext) {
    return (offerSection.extmap || []).some((offered) => offered.uri === ext.uri && offered.id === ext.id);
}

/**
 * Build lines for an active consumer m-section.
 *
 * Codecs are the consumer's own, with the consumer's payload types (an RTX apt
 * included): the worker stamps consumer.rtpParameters payload types on the RTP and
 * mediasoup has no way to renumber a consumer, so answering with the offer's numbers
 * would make the SDP disagree with the wire (owner decision for
 * section-189067a43c5f50160f1b8635/Q-001, option a). An offer numbered like the
 * router gets the same answer as before.
 *
 * Header extensions and RTCP feedback are the consumer's own, limited to what the
 * offer lists. The consumer stamps its rtpParameters.headerExtensions ids on its RTP
 * and mediasoup has no way to renumber them either, so an extension is answered only
 * when the offer lists the same uri with the same id.
 */
function buildActiveSection(offerSection, mid, consumer, iceParameters, iceCandidates, fpLine, answerSetup) {
    const rtp = consumer.rtpParameters;
    const codecs = rtp.codecs || [];
    const encodings = rtp.encodings || [];
    const headerExtensions = rtp.headerExtensions || [];

    // The offer codec each consumer codec matches. Only its payload type is used, to find
    // the feedback the offer lists for that codec: it never goes into the answer.
    const offerPtByConsumerPt = new Map();
    for (const codec of codecs) {
        const offerPt = findOfferPt(offerSection, codec, offerPtByConsumerPt);
        if (offerPt != null) offerPtByConsumerPt.set(codec.payloadType, offerPt);
    }

    const payloadTypes = codecs.map(c => c.payloadType);

    const lines = [
        `m=${offerSection.kind} 9 UDP/TLS/RTP/SAVPF ${payloadTypes.join(' ')}`,
        'c=IN IP4 0.0.0.0',
        'a=rtcp:9 IN IP4 0.0.0.0',
        `a=ice-ufrag:${iceParameters.usernameFragment}`,
        `a=ice-pwd:${iceParameters.password}`,
    ];

    if (fpLine) lines.push(fpLine);
    lines.push(`a=setup:${answerSetup}`);
    lines.push(`a=mid:${mid}`);
    lines.push('a=sendonly');
    lines.push('a=rtcp-mux');
    lines.push('a=rtcp-rsize');

    // Codecs: rtpmap, fmtp, rtcp-fb, with the consumer's payload types and parameters
    for (const codec of codecs) {
        const pt = codec.payloadType;
        const mime = codec.mimeType || '';
        const codecName = mime.split('/')[1] || 'unknown';
        const clockRate = codec.clockRate;
        const channels = codec.channels;
        lines.push(`a=rtpmap:${pt} ${codecName}/${clockRate}${channels ? '/' + channels : ''}`);

        // fmtp
        const params = codec.parameters;
        if (params && Object.keys(params).length > 0) {
            const fmtpStr = Object.entries(params)
                .map(([k, v]) => (v !== undefined && v !== '') ? `${k}=${v}` : k)
                .join(';');
            lines.push(`a=fmtp:${pt} ${fmtpStr}`);
        }

        // rtcp-fb: only feedback the consumer codec has and the offer listed for the
        // matching offer codec (under the offer's payload type) or for all of them. A
        // codec with no matching offer codec has no per-payload-type offer, so only the
        // wildcard counts. It is written under the consumer's payload type.
        const offerPt = offerPtByConsumerPt.has(pt) ? offerPtByConsumerPt.get(pt) : null;
        const offeredFeedback = getOfferedFeedback(offerSection, offerPt);
        const writtenFeedback = new Set();
        for (const fb of (codec.rtcpFeedback || [])) {
            const key = feedbackText(fb);
            if (!offeredFeedback.has(key) || writtenFeedback.has(key)) continue;
            writtenFeedback.add(key);
            const fbStr = fb.parameter ? `${fb.type} ${fb.parameter}` : fb.type;
            lines.push(`a=rtcp-fb:${pt} ${fbStr}`);
        }
    }

    // Header extensions: the consumer's, limited to the (uri, id) pairs the offer
    // lists. Each id and each uri is written once.
    const writtenExtIds = new Set();
    const writtenExtUris = new Set();
    for (const ext of headerExtensions) {
        if (!isExtensionOffered(offerSection, ext)) continue;
        if (writtenExtIds.has(ext.id) || writtenExtUris.has(ext.uri)) continue;
        writtenExtIds.add(ext.id);
        writtenExtUris.add(ext.uri);
        lines.push(`a=extmap:${ext.id} ${ext.uri}`);
    }

    // SSRC lines
    const primarySSRC = encodings[0]?.ssrc;
    const rtxSSRC = encodings[0]?.rtx?.ssrc;

    if (primarySSRC != null && rtxSSRC != null) {
        lines.push(`a=ssrc-group:FID ${primarySSRC} ${rtxSSRC}`);
        lines.push(`a=ssrc:${primarySSRC} cname:whep`);
        lines.push(`a=ssrc:${rtxSSRC} cname:whep`);
    } else if (primarySSRC != null) {
        lines.push(`a=ssrc:${primarySSRC} cname:whep`);
    }

    // ICE candidates
    for (const cand of (iceCandidates || [])) {
        const proto = cand.protocol || 'udp';
        const type = cand.type || 'host';
        lines.push(`a=candidate:1 1 ${proto.toUpperCase()} 2130706431 ${cand.ip} ${cand.port} typ ${type}`);
    }
    lines.push('a=end-of-candidates');

    return lines;
}

/**
 * Build a filtered RTP capabilities object from the viewer's SDP offer.
 *
 * mediasoup's `canConsume()` and `transport.consume()` accept `rtpCapabilities`
 * that describe what the remote endpoint can receive. For Socket.IO viewers the
 * client-side mediasoup-client `device.rtpCapabilities` fills this role, but
 * WHEP viewers only send a raw SDP offer — there is no mediasoup device on the
 * viewer side.
 *
 * Using the router's own capabilities as a stand-in (as was done before this
 * fix) means a video-only offer can still allocate an audio consumer, and a
 * viewer whose offer does not include the producer's codec profile will still
 * get a "successful" answer built from incompatible consumer params.
 *
 * This function walks the parsed offer's media sections and intersects the
 * viewer's declared codecs against the router's capabilities to produce a
 * capabilities object that accurately represents what the viewer can receive.
 * Only offer sections that can receive (see isOfferSectionEligible) are read.
 *
 * Header extensions and RTCP feedback are limited to what the offer lists, and the
 * router's codec objects are copied, never handed out. An extension is kept only when
 * the offer's id for its uri equals the id the router (and so the consumer) uses; see
 * the comment at the header extension loop.
 *
 * H.264 router codecs match on the parsed profile and the packetization-mode (see
 * isH264Compatible) and are handed out with the viewer's own H.264 parameters.
 *
 * @param {object} parsedOffer - result of parseViewerOffer()
 * @param {object} routerCapabilities - mediasoupRouter.rtpCapabilities
 * @returns {object} Filtered rtpCapabilities suitable for canConsume/consume
 */
function buildViewerRtpCapabilities(parsedOffer, routerCapabilities) {
    const offerSections = parsedOffer._mediaSections || [];
    const routerCodecs = routerCapabilities.codecs || [];
    const routerExts = routerCapabilities.headerExtensions || [];

    // Only sections the viewer can receive on count (the rule createViewerAnswer
    // uses to hand out consumers): not disabled, and recvonly or sendrecv. A kind
    // is "active" when it has such a section.
    const receivableSections = offerSections.filter(isOfferSectionEligible);
    const activeKinds = new Set(receivableSections.map((section) => section.kind));

    // createViewerAnswer gives a kind's consumer to its first receivable section, so
    // that section's extensions and feedback are the ones the consumer must honour.
    const receivingSectionByKind = {};
    for (const section of receivableSections) {
        if (!receivingSectionByKind[section.kind]) receivingSectionByKind[section.kind] = section;
    }

    // Build a lookup of codec names + key parameters the viewer declares,
    // keyed by kind. We normalize names to uppercase for matching.
    const viewerCodecsByKind = { video: [], audio: [] };
    for (const section of receivableSections) {
        for (const codec of section.codecs) {
            viewerCodecsByKind[section.kind].push({
                section,
                payloadType: codec.payloadType,
                name: codec.name.toUpperCase(),
                clockRate: codec.clockRate,
                channels: codec.channels,
                fmtp: section.fmtp[codec.payloadType] || {},
            });
        }
    }

    // Intersect with router codecs. A router codec matches if:
    // 1. The kind is active in the viewer offer
    // 2. The codec name matches (case-insensitive)
    // 3. Clock rates match
    // 4. For H264: the parsed profile (profile_idc with the profile-iop bits, level
    //    ignored) and the packetization-mode match; a viewer entry without
    //    profile-level-id is 42e01f, not a wildcard
    // 5. For audio: channel count matches (if specified)
    const filteredCodecs = [];
    for (const rc of routerCodecs) {
        const kind = rc.kind;
        if (!activeKinds.has(kind)) continue;

        const rcName = (rc.mimeType || '').split('/')[1]?.toUpperCase();
        if (!rcName) continue;

        const viewerCodecs = viewerCodecsByKind[kind] || [];
        const matchedViewerCodecs = viewerCodecs.filter((vc) => {
            if (vc.name !== rcName) return false;
            if (vc.clockRate !== rc.clockRate) return false;

            // Channel count check for audio
            if (kind === 'audio' && rc.channels && vc.channels && vc.channels !== rc.channels) {
                return false;
            }

            // H264 profile and packetization-mode matching
            if (rcName === 'H264' && !isH264Compatible(rc.parameters, vc.fmtp)) return false;

            return true;
        });

        if (matchedViewerCodecs.length === 0) continue;

        // An H.264 router codec is handed to mediasoup once per distinct parameter set the
        // matching viewer entries carry, with those parameters instead of the router's:
        // mediasoup's canConsume/consume match the capability against the producer's
        // codec, so only the viewer's own profile-level-id and packetization-mode let it
        // see what the viewer offered. Other codecs are one entry.
        const variants = [];
        if (rcName === 'H264') {
            const variantByKey = new Map();
            for (const vc of matchedViewerCodecs) {
                const parameters = buildViewerH264Parameters(rc, vc.fmtp);
                const key = JSON.stringify(parameters);
                if (!variantByKey.has(key)) {
                    variantByKey.set(key, { parameters, viewerCodecs: [] });
                    variants.push(variantByKey.get(key));
                }
                variantByKey.get(key).viewerCodecs.push(vc);
            }
        } else {
            variants.push({ parameters: { ...rc.parameters }, viewerCodecs: matchedViewerCodecs });
        }

        // The consumer copies this codec's rtcpFeedback, so hand mediasoup only the
        // feedback the viewer offered for the matched payload types in the section
        // that will be answered (or for all payload types), not the router's own list.
        const receivingSection = receivingSectionByKind[kind];
        for (const { parameters, viewerCodecs: variantCodecs } of variants) {
            const offeredFeedback = new Set();
            for (const vc of variantCodecs) {
                if (vc.section !== receivingSection) continue;
                for (const text of getOfferedFeedback(vc.section, vc.payloadType)) offeredFeedback.add(text);
            }
            for (const text of getOfferedFeedback(receivingSection, null)) offeredFeedback.add(text);

            filteredCodecs.push({
                ...rc,
                parameters,
                rtcpFeedback: (rc.rtcpFeedback || []).filter((fb) => offeredFeedback.has(feedbackText(fb))),
            });
        }
    }

    // Header extensions: only those the viewer offered. mediasoup keeps a consumer
    // extension when some capability entry has the same uri and a preferredId equal to
    // the router's id for it, whatever the entry's kind. So each entry carries the
    // offered id: the consumer then keeps the extension only when the offered id is the
    // id it will stamp, and the answer can name it without lying about the wire.
    const isOffered = (kind, uri, id) => {
        const section = receivingSectionByKind[kind];
        return !!section && isExtensionOffered(section, { uri, id });
    };
    const filteredExts = [];
    for (const ext of routerExts) {
        const section = receivingSectionByKind[ext.kind];
        if (!section) continue;

        const offeredIds = (section.extmap || []).filter((offered) => offered.uri === ext.uri).map((offered) => offered.id);
        if (offeredIds.length === 0) continue;
        const preferredId = offeredIds.includes(ext.preferredId) ? ext.preferredId : offeredIds[0];

        // The entry also reaches the other kind's consumer when the router uses this
        // id for the same uri there. Leave it out if that kind's section did not offer it.
        const reachesUnofferedKind = routerExts.some((other) => other.uri === ext.uri
            && other.preferredId === preferredId
            && receivingSectionByKind[other.kind]
            && !isOffered(other.kind, other.uri, preferredId));
        if (reachesUnofferedKind) continue;

        filteredExts.push({ ...ext, preferredId });
    }

    return {
        codecs: filteredCodecs,
        headerExtensions: filteredExts,
    };
}

// ── Payload types a viewer can decode ──
//
// A WHEP viewer is the offerer and only receives, so it decodes a payload type only as the codec
// its own offer gave that number (RFC 3264 section 5.1): Chromium 153 and Firefox 155 decode
// nothing that arrives on another number, whatever the answer says. A mediasoup consumer sends
// with its router's numbers (the worker stamps them as the producer's RTP enters the router) and
// cannot renumber. So a viewer is served from a router whose numbers for the room's codecs, and
// for the video codec's RTX, are its offer's: the main router when they agree, otherwise a router
// made for that numbering, with the room's producers piped into it (lib/whepLayoutRouters.js).

/** An offer this server cannot serve; status is the HTTP status to answer with. */
class WhepOfferError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = 'WhepOfferError';
        this.status = status;
    }
}

// The order in which mediasoup (3.27.1, ortc.js DynamicPayloadTypes) numbers a router codec
// that has no preferredPayloadType, and every RTX codec: the first number of this list that no
// codec of the router has taken yet. A router's mediaCodecs cannot name an RTX codec or its number.
const MEDIASOUP_DYNAMIC_PAYLOAD_TYPES = [
    100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114,
    115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 96, 97, 98, 99,
];

// An audio codec mediasoup supports that no producer here sends and no browser offers. A layout
// router lists it under each number that must be taken before mediasoup numbers the video codec's
// RTX, so that the RTX gets the number the offer gives it.
const LAYOUT_FILLER_CODEC = Object.freeze({ kind: 'audio', mimeType: 'audio/SILK', clockRate: 8000 });

function isRtxMimeType(mimeType) {
    return /\/rtx$/i.test(String(mimeType || ''));
}

function isRtpPayloadType(value) {
    return Number.isInteger(value) && value >= 0 && value <= 127;
}

/** The offer section a kind's consumer is answered in (the rule createViewerAnswer uses). */
function receivingOfferSection(parsedOffer, kind) {
    return (parsedOffer._mediaSections || []).find((section) => section.kind === kind && isOfferSectionEligible(section)) || null;
}

/** The offer's RTX payload type for one of its media payload types, or null. */
function findOfferRtxPayloadType(offerSection, payloadType, clockRate) {
    const rtx = (offerSection.codecs || []).find((codec) => codec.name === 'RTX'
        && codec.clockRate === clockRate
        && Number(offerSection.fmtp[codec.payloadType]?.apt) === payloadType);
    return rtx ? rtx.payloadType : null;
}

/**
 * The numbers a viewer offer gives the codecs the room's producers send.
 *
 * producers is { video, audio } (mediasoup Producers of the main router, either may be null).
 * Each producer the offer can receive gets an entry:
 *   kind, producer;
 *   codec: the main router's capability codec the producer is consumed as;
 *   payloadType: the offer's number for that codec (the first matching offer entry, as
 *     findOfferPt matches; H.264 by profile and packetization-mode);
 *   offerRtxPayloadType: the offer's RTX number for it, or null (video only);
 *   rtxPayloadType: the RTX number a router can give it: offerRtxPayloadType when mediasoup can
 *     allocate that number (MEDIASOUP_DYNAMIC_PAYLOAD_TYPES) and no entry uses it, else null.
 *     Without one the consumer has no RTX and NACK retransmits on the media stream.
 * A producer whose codec the offer does not list gets no entry (it cannot be consumed).
 *
 * Returns null when a producer carries no consumableRtpParameters (not a mediasoup Producer):
 * then nothing can be planned and the main router serves, as before. Throws WhepOfferError for
 * an offer whose numbers no router can send with.
 */
function planViewerPayloadTypes(parsedOffer, producers, routerCapabilities) {
    const entries = [];
    for (const kind of ['video', 'audio']) {
        const producer = producers?.[kind];
        if (!producer) continue;
        const mediaCodec = producer.consumableRtpParameters?.codecs?.find((codec) => !isRtxMimeType(codec.mimeType));
        if (!mediaCodec) return null;
        const routerCodec = (routerCapabilities.codecs || [])
            .find((codec) => codec.kind === kind && codec.preferredPayloadType === mediaCodec.payloadType);
        if (!routerCodec) return null;

        const section = receivingOfferSection(parsedOffer, kind);
        if (!section) continue;
        const payloadType = findOfferPt(section, mediaCodec, null);
        if (payloadType == null) continue;
        if (!isRtpPayloadType(payloadType)) {
            throw new WhepOfferError(`The offer gives ${routerCodec.mimeType} payload type ${payloadType}; RTP payload types are 0-127`);
        }
        const offerRtx = kind === 'video' ? findOfferRtxPayloadType(section, payloadType, mediaCodec.clockRate) : null;

        const codec = {
            kind,
            mimeType: routerCodec.mimeType,
            clockRate: routerCodec.clockRate,
            parameters: { ...(routerCodec.parameters || {}) },
        };
        if (routerCodec.channels !== undefined) codec.channels = routerCodec.channels;
        entries.push({
            kind,
            producer,
            codec,
            payloadType,
            offerRtxPayloadType: isRtpPayloadType(offerRtx) ? offerRtx : null,
            rtxPayloadType: null,
        });
    }

    for (const entry of entries) {
        const other = entries.find((candidate) => candidate !== entry && candidate.payloadType === entry.payloadType);
        if (other) {
            throw new WhepOfferError(`The offer gives payload type ${entry.payloadType} to both ${entry.codec.mimeType} and ${other.codec.mimeType}; a bundled offer gives each codec its own number`);
        }
    }
    const taken = new Set(entries.map((entry) => entry.payloadType));
    for (const entry of entries) {
        const rtx = entry.offerRtxPayloadType;
        if (rtx != null && MEDIASOUP_DYNAMIC_PAYLOAD_TYPES.includes(rtx) && !taken.has(rtx)) entry.rtxPayloadType = rtx;
    }
    return { entries };
}

function codecParametersKey(parameters) {
    return Object.keys(parameters || {}).sort().map((key) => `${key}=${parameters[key]}`).join(';');
}

function isSameRouterCodec(a, b) {
    return String(a.mimeType).toLowerCase() === String(b.mimeType).toLowerCase()
        && a.clockRate === b.clockRate
        && (a.channels || 1) === (b.channels || 1)
        && codecParametersKey(a.parameters) === codecParametersKey(b.parameters);
}

/** A plan entry as a string: two entries with the same key need the same router numbering. */
function payloadLayoutKey(entry) {
    const { codec } = entry;
    return [
        entry.kind,
        `${String(codec.mimeType).toLowerCase()}/${codec.clockRate}${codec.channels ? `/${codec.channels}` : ''}`,
        codecParametersKey(codec.parameters),
        `pt=${entry.payloadType}`,
        `rtx=${entry.rtxPayloadType ?? '-'}`,
    ].filter(Boolean).join(' ');
}

/**
 * Whether a router with these capabilities sends the entry's codec on the entry's payload type,
 * and its RTX on the entry's RTX number when the entry has one.
 */
function routerServesPayloadLayout(routerCapabilities, entry) {
    const codecs = routerCapabilities?.codecs || [];
    const media = codecs.find((codec) => codec.preferredPayloadType === entry.payloadType);
    if (!media || isRtxMimeType(media.mimeType) || !isSameRouterCodec(media, entry.codec)) return false;
    if (entry.rtxPayloadType == null) return true;
    const rtx = codecs.find((codec) => isRtxMimeType(codec.mimeType) && codec.parameters?.apt === entry.payloadType);
    return rtx?.preferredPayloadType === entry.rtxPayloadType;
}

/**
 * The mediaCodecs of a router that numbers the plan's codecs as the offer does: each codec with
 * its offer number as preferredPayloadType, audio first. mediasoup takes no number for an RTX
 * codec; it gives the video codec's RTX the first free number of MEDIASOUP_DYNAMIC_PAYLOAD_TYPES
 * right after the video codec. So when the entry has an rtxPayloadType, every number ahead of it
 * in that list that the plan does not use is taken first by a LAYOUT_FILLER_CODEC entry. A plan
 * has at most one video entry (one video producer per room).
 */
function buildLayoutMediaCodecs(plan) {
    const entries = plan.entries || [];
    const planned = new Set(entries.map((entry) => entry.payloadType));
    const codecFor = (entry) => {
        const { kind, mimeType, clockRate, channels, parameters } = entry.codec;
        const codec = { kind, mimeType, clockRate, preferredPayloadType: entry.payloadType, parameters: { ...(parameters || {}) } };
        if (channels !== undefined) codec.channels = channels;
        return codec;
    };

    const mediaCodecs = entries.filter((entry) => entry.kind === 'audio').map(codecFor);
    for (const entry of entries.filter((candidate) => candidate.kind === 'video')) {
        if (entry.rtxPayloadType != null) {
            for (const payloadType of MEDIASOUP_DYNAMIC_PAYLOAD_TYPES) {
                if (payloadType === entry.rtxPayloadType) break;
                if (!planned.has(payloadType)) mediaCodecs.push({ ...LAYOUT_FILLER_CODEC, preferredPayloadType: payloadType });
            }
        }
        mediaCodecs.push(codecFor(entry));
    }
    return mediaCodecs;
}

/**
 * Keep in a viewer's capabilities only the RTX codec its offer can receive: the router's RTX for
 * a planned codec, when the router gives it the number the offer gives that codec's RTX. mediasoup
 * gives a consumer RTX whenever the capabilities hold an RTX codec (it does not compare apt), on
 * the router's number; with none left the consumer keeps NACK and retransmits on the media stream.
 */
function limitViewerRtxToOffer(capabilities, routerCapabilities, plan) {
    const allowed = new Set();
    for (const entry of plan.entries) {
        if (entry.offerRtxPayloadType == null) continue;
        const rtx = (routerCapabilities.codecs || [])
            .find((codec) => isRtxMimeType(codec.mimeType) && codec.parameters?.apt === entry.payloadType);
        if (rtx && rtx.preferredPayloadType === entry.offerRtxPayloadType) allowed.add(rtx.preferredPayloadType);
    }
    return {
        ...capabilities,
        codecs: (capabilities.codecs || []).filter((codec) => !isRtxMimeType(codec.mimeType) || allowed.has(codec.preferredPayloadType)),
    };
}

module.exports = {
    parseViewerOffer,
    parseViewerDtls,
    createViewerAnswer,
    buildViewerRtpCapabilities,
    parseH264ProfileLevelId,
    isSameH264Profile,
    isH264Compatible,
    WhepOfferError,
    planViewerPayloadTypes,
    payloadLayoutKey,
    routerServesPayloadLayout,
    buildLayoutMediaCodecs,
    limitViewerRtxToOffer,
};
