TASK-023 (lane whep): createViewerAnswer now gives a consumer only to an offer section with port != 0 and direction recvonly or sendrecv (no direction counts as sendrecv); every other section is answered in place as port 0, a=inactive, with its offered a=mid, and stays out of BUNDLE. Verify commands, lint, typecheck and npm test (508 tests) pass.

Left open, outside this item (not changed):
- buildViewerRtpCapabilities (lib/whep.js) still treats a section as active when port != 0 and direction != 'inactive', so a sendonly section counts as active there but is now rejected in the answer; and it collects codecs from every section of an active kind, including disabled or inactive ones. Aligning it with isOfferSectionEligible is a small change, but that function belongs to the H.264 / extension tasks (TASK-024, TASK-026), so it was left for them.
- parseViewerOffer reads direction only inside a media section; a session-level a=inactive / a=sendonly is ignored.
- parseViewerOffer does not recognise m=application (data channel) sections, so such an offer would get fewer m-lines in the answer than in the offer, and its attributes land on the previous media section.
