# Lanes (October 24, 2026)

Each lane is a worktree in `C:\Users\V\nextra-lanes\<lane>` on branch `lane/<lane>`. The driver merges a lane into
`dev` when its task hands back, reruns the suite on `dev` now and then, and fast-forwards the lane to `dev` before
its next task. Lanes share no source file the plan names except `server.js`, `config.js`, `README.md`,
`lib/socket.js`, `lib/whep.js`, `src/HostView.jsx`, `src/WatchView.jsx` and `tests/serverIntegration.test.js`,
which Git merges by line.

| Lane | Done | Still to do, in order |
|---|---|---|
| whip | 020 021 022 033 034 | 035 036 037 038 039 040 |
| obs | 078 079 080 | 081 082 083 084 095 · then 096 099 102 once whip's 040 is merged |
| host | 063 064 | 068 069 070 071 072 |
| watch | 059 060 074 105 | check 13 · 085 once host's 068 is merged · 087 088 089 090 091 092 |
| server | 054 055 056 057 | 058 094 |
| netcheck | | 103 |
| whep | 023 024 026 | 025 027 101 |
| socket | 013 014 015 016 028 | check 20 |
| libmisc | 017 018 097 029 030 073 | 100 |
| scripts | 041 042 043 048 049 | check 09 |
| client | 061 062 075 077 | check 14 |
| package | 045 | 046 047 031 032 |
| smoke | 050 | 051 052 |
| fmp4 | 065 | 066 067 076 |
| rooms | 019 098 | check 11 |
| depack | 093 | 086 |
| lifecycle | 104 044 | check 16 |

Unsure checks still unassigned: 08, 10, 12, 15, 17, 18, 19 (they go to lanes as they free up).
