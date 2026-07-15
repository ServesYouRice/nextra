import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export default function ShareQrCode({ value, label = 'Scan to watch' }) {
    const [dataUrl, setDataUrl] = useState('');

    useEffect(() => {
        let active = true;
        if (!value) {
            return () => { active = false; };
        }
        QRCode.toDataURL(value, { width: 180, margin: 1, errorCorrectionLevel: 'M' })
            .then((url) => { if (active) setDataUrl(url); })
            .catch(() => { if (active) setDataUrl(''); });
        return () => { active = false; };
    }, [value]);

    if (!dataUrl) return null;
    return (
        <details className="share-qr">
            <summary>{label}</summary>
            <img src={dataUrl} alt={`QR code for ${value}`} width="180" height="180" />
            <p>Generated locally in this browser.</p>
        </details>
    );
}
