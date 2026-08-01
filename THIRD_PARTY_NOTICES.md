# Third-party notices

Nextra includes open-source dependencies recorded in `package-lock.json` and the
packaged `SBOM.cdx.json`. Their license texts and repository locations are
available in their respective package distributions.

The release gate checks every production dependency in `package-lock.json` and
`poc-mediasoup/package-lock.json` for declared license metadata. The currently
reviewed dependency licenses are 0BSD, Apache-2.0, BSD-2-Clause, BSD-3-Clause,
BlueOak-1.0.0, ISC, and MIT. A missing or new license identifier fails the gate so
its distribution terms can be reviewed before release.

Packaged Windows releases also include Cloudflare `cloudflared`, licensed under
Apache License 2.0. Project and license information:

- https://github.com/cloudflare/cloudflared
- https://www.apache.org/licenses/LICENSE-2.0

This notice is informational and does not replace review of the final release
artifact and its complete dependency licenses.
