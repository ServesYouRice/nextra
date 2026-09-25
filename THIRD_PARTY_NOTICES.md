# Third-party notices

Nextra includes open-source dependencies recorded in `package-lock.json` and the
packaged `SBOM.cdx.json`. Their license texts and repository locations are
available in their respective package distributions.

The release gate checks every production dependency in `package-lock.json` and
`poc-mediasoup/package-lock.json` for declared license metadata. The currently
reviewed dependency licenses are 0BSD, Apache-2.0, BSD-2-Clause, BSD-3-Clause,
BlueOak-1.0.0, ISC, and MIT. A missing or new license identifier fails the gate so
its distribution terms can be reviewed before release.

Packaged releases also include Cloudflare `cloudflared`, licensed under
Apache License 2.0. Project and license information:

- https://github.com/cloudflare/cloudflared
- https://www.apache.org/licenses/LICENSE-2.0

Packaged releases also include an unmodified static FFmpeg 9.0.2 executable,
run as a separate process for the H.264 relay. These builds enable GPL
components such as libx264 and are licensed under the GNU General Public
License version 3 or later; the license text is in `licenses/FFmpeg-GPL-3.0.txt`.
The pinned archives and their SHA-256 digests are listed in
`scripts/ffmpeg-manifest.json`. Source and build information:

- FFmpeg source: https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz
- Windows x64 build (gyan.dev essentials): https://www.gyan.dev/ffmpeg/builds/ and
  https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2
- macOS arm64 build (Martin Riedl): https://ffmpeg.martin-riedl.de/ and
  https://git.martin-riedl.de/ffmpeg/build-script

This notice is informational and does not replace review of the final release
artifact and its complete dependency licenses.
