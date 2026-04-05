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
 * Extract DTLS parameters from a parsed viewer offer.
 * For WHEP the server is the media sender; when the viewer offers actpass,
 * the server takes DTLS role 'server' (answers a=setup:passive).
 */
function parseViewerDtls(parsedOffer) {
    const section = parsedOffer.video || parsedOffer.audio;
    if (!section || !section.fingerprint) return null;

    const { algorithm, value } = section.fingerprint;

    // The role here is the REMOTE peer's DTLS role as passed to mediasoup.
    // Viewer offers actpass -> we answer passive, so viewer acts as DTLS client -> role = 'client'
    // Viewer offers active -> viewer is DTLS client -> role = 'client'
    // Viewer offers passive -> viewer is DTLS server -> role = 'server'
    const role = section.setup === 'passive' ? 'server' : 'client';

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
        const consumer = consumersByKind[section.kind];
        const mid = section.mid || (section.kind === 'video' ? '0' : '1');

        if (!consumer) {
            // Reject this m-section
            sectionLines.push(buildRejectedSection(section.kind, mid));
            continue;
        }

        // Remove from map so each consumer is used once
        delete consumersByKind[section.kind];
        activeMids.push(mid);
        sectionLines.push(buildActiveSection(
            section, mid, consumer, iceParameters, iceCandidates, fpLine
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
 * Build lines for a rejected m-section (port 0).
 */
function buildRejectedSection(kind, mid) {
    return [
        `m=${kind} 0 UDP/TLS/RTP/SAVPF 0`,
        'c=IN IP4 0.0.0.0',
        `a=mid:${mid}`,
        'a=inactive',
    ];
}

/**
 * Find the offer codec that matches a consumer codec by name and clock rate.
 * Returns the offer's payload type, or null if no match.
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

            // For H264, check profile-level-id and packetization-mode
            if (codecName === 'H264') {
                const offerFmtp = offerSection.fmtp[offerCodec.payloadType] || {};
                const consumerProfile = consumerCodec.parameters?.['profile-level-id']?.slice(0, 2)?.toLowerCase();
                const offerProfile = offerFmtp['profile-level-id']?.slice(0, 2)?.toLowerCase();
                if (consumerProfile && offerProfile && consumerProfile !== offerProfile) continue;

                // packetization-mode must match (default is 0 if absent)
                const consumerPM = String(consumerCodec.parameters?.['packetization-mode'] ?? '0');
                const offerPM = String(offerFmtp['packetization-mode'] ?? '0');
                if (consumerPM !== offerPM) continue;
            }

            return offerCodec.payloadType;
        }
    }
    return null;
}

/**
 * Find the offer extmap ID for a given header extension URI.
 */
function findOfferExtId(offerSection, uri) {
    for (const ext of (offerSection.extmap || [])) {
        if (ext.uri === uri) return ext.id;
    }
    return null;
}

/**
 * Build lines for an active consumer m-section.
 * The answer must use the payload types from the offer, not mediasoup's internal PTs.
 */
function buildActiveSection(offerSection, mid, consumer, iceParameters, iceCandidates, fpLine) {
    const rtp = consumer.rtpParameters;
    const codecs = rtp.codecs || [];
    const encodings = rtp.encodings || [];
    const headerExtensions = rtp.headerExtensions || [];

    // Map each consumer codec to the offer's PT. If we can't find a match,
    // fall back to the consumer's own PT (shouldn't happen for valid offers).
    const ptMap = new Map(); // consumer PT -> offer PT
    const mappedCodecs = codecs.map(codec => {
        const offerPt = findOfferPt(offerSection, codec, ptMap);
        const answerPt = offerPt != null ? offerPt : codec.payloadType;
        ptMap.set(codec.payloadType, answerPt);
        
        // Deep copy codec and remap RTX apt parameter
        const mappedCodec = JSON.parse(JSON.stringify(codec));
        mappedCodec.answerPt = answerPt;
        if (mappedCodec.parameters?.apt) {
            mappedCodec.parameters.apt = ptMap.get(mappedCodec.parameters.apt) || mappedCodec.parameters.apt;
        }
        return mappedCodec;
    });

    const payloadTypes = mappedCodecs.map(c => c.answerPt);

    const lines = [
        `m=${offerSection.kind} 9 UDP/TLS/RTP/SAVPF ${payloadTypes.join(' ')}`,
        'c=IN IP4 0.0.0.0',
        'a=rtcp:9 IN IP4 0.0.0.0',
        `a=ice-ufrag:${iceParameters.usernameFragment}`,
        `a=ice-pwd:${iceParameters.password}`,
    ];

    if (fpLine) lines.push(fpLine);
    lines.push('a=setup:passive');
    lines.push(`a=mid:${mid}`);
    lines.push('a=sendonly');
    lines.push('a=rtcp-mux');
    lines.push('a=rtcp-rsize');

    // Codecs: rtpmap, fmtp, rtcp-fb — using remapped PTs
    for (const codec of mappedCodecs) {
        const pt = codec.answerPt;
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

        // rtcp-fb
        const feedbacks = codec.rtcpFeedback || [];
        for (const fb of feedbacks) {
            const fbStr = fb.parameter ? `${fb.type} ${fb.parameter}` : fb.type;
            lines.push(`a=rtcp-fb:${pt} ${fbStr}`);
        }
    }

    // Header extensions — remap IDs to match offer
    for (const ext of headerExtensions) {
        const offerId = findOfferExtId(offerSection, ext.uri);
        const id = offerId != null ? offerId : ext.id;
        lines.push(`a=extmap:${id} ${ext.uri}`);
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
 *
 * @param {object} parsedOffer - result of parseViewerOffer()
 * @param {object} routerCapabilities - mediasoupRouter.rtpCapabilities
 * @returns {object} Filtered rtpCapabilities suitable for canConsume/consume
 */
function buildViewerRtpCapabilities(parsedOffer, routerCapabilities) {
    const offerSections = parsedOffer._mediaSections || [];
    const routerCodecs = routerCapabilities.codecs || [];
    const routerExts = routerCapabilities.headerExtensions || [];

    // Collect the set of media kinds the viewer is actually requesting.
    // A section is "active" if it exists, has a non-zero port, and is not
    // explicitly inactive.
    const activeKinds = new Set();
    for (const section of offerSections) {
        if (section.port !== 0 && section.direction !== 'inactive') {
            activeKinds.add(section.kind);
        }
    }

    // Build a lookup of codec names + key parameters the viewer declares,
    // keyed by kind. We normalize names to uppercase for matching.
    const viewerCodecsByKind = { video: [], audio: [] };
    for (const section of offerSections) {
        if (!activeKinds.has(section.kind)) continue;
        for (const codec of section.codecs) {
            viewerCodecsByKind[section.kind].push({
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
    // 4. For H264: profile-level-id first byte (profile_idc) matches, or the
    //    viewer did not specify a profile (wildcard)
    // 5. For audio: channel count matches (if specified)
    const filteredCodecs = [];
    for (const rc of routerCodecs) {
        const kind = rc.kind;
        if (!activeKinds.has(kind)) continue;

        const rcName = (rc.mimeType || '').split('/')[1]?.toUpperCase();
        if (!rcName) continue;

        const viewerCodecs = viewerCodecsByKind[kind] || [];
        const matched = viewerCodecs.some((vc) => {
            if (vc.name !== rcName) return false;
            if (vc.clockRate !== rc.clockRate) return false;

            // Channel count check for audio
            if (kind === 'audio' && rc.channels && vc.channels && vc.channels !== rc.channels) {
                return false;
            }

            // H264 profile and packetization-mode matching
            if (rcName === 'H264') {
                const rcProfile = rc.parameters?.['profile-level-id']?.slice(0, 2)?.toLowerCase();
                const vcProfile = vc.fmtp['profile-level-id']?.slice(0, 2)?.toLowerCase();
                if (vcProfile && rcProfile && vcProfile !== rcProfile) return false;

                const rcPM = String(rc.parameters?.['packetization-mode'] ?? '0');
                const vcPM = String(vc.fmtp['packetization-mode'] ?? '0');
                if (rcPM !== vcPM) return false;
            }

            return true;
        });

        if (matched) {
            filteredCodecs.push(rc);
        }
    }

    // Keep all router header extensions for active kinds — viewers generally
    // accept whatever the server includes in the answer.
    const filteredExts = routerExts.filter((ext) => activeKinds.has(ext.kind));

    return {
        codecs: filteredCodecs,
        headerExtensions: filteredExts,
    };
}

module.exports = { parseViewerOffer, parseViewerDtls, createViewerAnswer, buildViewerRtpCapabilities };
